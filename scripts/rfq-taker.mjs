#!/usr/bin/env node
import process from 'node:process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddress,
} from '@solana/spl-token';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature, signUnsignedEnvelopeHex } from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR, STATE } from '../src/swap/constants.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { createInitialTrade, applySwapEnvelope } from '../src/swap/stateMachine.js';
import { verifySwapPrePayOnchain } from '../src/swap/verify.js';
import { normalizeClnNetwork } from '../src/ln/cln.js';
import { normalizeLndNetwork } from '../src/ln/lnd.js';
import { lnPay } from '../src/ln/client.js';
import { claimEscrowTx, LN_USDT_ESCROW_PROGRAM_ID } from '../src/solana/lnUsdtEscrowClient.js';
import { readSolanaKeypair } from '../src/solana/keypair.js';
import { SolanaRpcPool } from '../src/solana/rpcPool.js';
import { openTradeReceiptsStore } from '../src/receipts/store.js';
import { loadPeerWalletFromFile } from '../src/peer/keypair.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const defaultComposeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function parseBps(value, label, fallback) {
  const n = parseIntFlag(value, label, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10_000, n));
}

function splitCsv(value) {
  const s = String(value ?? '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function stripSignature(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

function ensureOk(res, label) {
  if (!res || typeof res !== 'object') throw new Error(`${label} failed (no response)`);
  if (res.type === 'error') throw new Error(`${label} failed: ${res.error}`);
  return res;
}

function signSwapEnvelope(unsignedEnvelope, { pubHex, secHex }) {
  const sigHex = signUnsignedEnvelopeHex(unsignedEnvelope, secHex);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: pubHex, sigHex });
  const v = validateSwapEnvelope(signed);
  if (!v.ok) throw new Error(`Internal error: signed envelope invalid: ${v.error}`);
  return signed;
}

function asBigIntAmount(value) {
  try {
    const s = String(value ?? '').trim();
    if (!s) return null;
    return BigInt(s);
  } catch (_e) {
    return null;
  }
}

async function sendAndConfirm(connection, tx) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf?.value?.err) {
    throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  }
  return sig;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');
  const peerKeypairPath = requireFlag(flags, 'peer-keypair');
  const rfqChannel = (flags.get('rfq-channel') && String(flags.get('rfq-channel')).trim()) || '0000intercomswapbtcusdt';
  const listenOffers = parseBool(flags.get('listen-offers'), false);
  const offerChannels = (() => {
    const raw = flags.get('offer-channels') ?? flags.get('offer-channel') ?? '';
    const chans = splitCsv(raw);
    const list = chans.length > 0 ? chans : [rfqChannel];
    return Array.from(new Set(list.map((c) => String(c || '').trim()).filter(Boolean)));
  })();
  const receiptsDbPath = flags.get('receipts-db') ? String(flags.get('receipts-db')).trim() : '';
  const persistPreimage = parseBool(flags.get('persist-preimage'), receiptsDbPath ? true : false);
  const stopAfterLnPay = parseBool(flags.get('stop-after-ln-pay'), false);

  const tradeId = (flags.get('trade-id') && String(flags.get('trade-id')).trim()) || `swap_${crypto.randomUUID()}`;

  let btcSats = parseIntFlag(flags.get('btc-sats'), 'btc-sats', 50_000);
  let usdtAmount = (flags.get('usdt-amount') && String(flags.get('usdt-amount')).trim()) || '100000000';
  const rfqValidSec = parseIntFlag(flags.get('rfq-valid-sec'), 'rfq-valid-sec', 60);

  const timeoutSec = parseIntFlag(flags.get('timeout-sec'), 'timeout-sec', 30);
  const rfqResendMs = parseIntFlag(flags.get('rfq-resend-ms'), 'rfq-resend-ms', 1200);
  const acceptResendMs = parseIntFlag(flags.get('accept-resend-ms'), 'accept-resend-ms', 1200);

  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 200);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);

  const runSwap = parseBool(flags.get('run-swap'), false);
  const swapTimeoutSec = parseIntFlag(flags.get('swap-timeout-sec'), 'swap-timeout-sec', 300);
  const swapResendMs = parseIntFlag(flags.get('swap-resend-ms'), 'swap-resend-ms', 1200);
  // Guardrail: require the Solana refund timelock in TERMS to be far enough in the future
  // to allow recovery (crash/restart/RPC outage) after paying the LN invoice.
  const minSolRefundWindowSecCfg = parseIntFlag(
    flags.get('min-solana-refund-window-sec'),
    'min-solana-refund-window-sec',
    72 * 3600
  );
  const maxSolRefundWindowSecCfg = parseIntFlag(
    flags.get('max-solana-refund-window-sec'),
    'max-solana-refund-window-sec',
    7 * 24 * 3600
  );
  const maxPlatformFeeBpsCfg = parseBps(flags.get('max-platform-fee-bps'), 'max-platform-fee-bps', 500);
  const maxTradeFeeBpsCfg = parseBps(flags.get('max-trade-fee-bps'), 'max-trade-fee-bps', 1000);
  const maxTotalFeeBpsCfg = parseBps(flags.get('max-total-fee-bps'), 'max-total-fee-bps', 1500);

  const SOL_REFUND_MIN_SEC = 3600; // 1h
  const SOL_REFUND_MAX_SEC = 7 * 24 * 3600; // 1w
  if (!Number.isFinite(minSolRefundWindowSecCfg) || minSolRefundWindowSecCfg < SOL_REFUND_MIN_SEC) {
    die(`Invalid --min-solana-refund-window-sec (must be >= ${SOL_REFUND_MIN_SEC})`);
  }
  if (!Number.isFinite(maxSolRefundWindowSecCfg) || maxSolRefundWindowSecCfg > SOL_REFUND_MAX_SEC) {
    die(`Invalid --max-solana-refund-window-sec (must be <= ${SOL_REFUND_MAX_SEC})`);
  }
  if (minSolRefundWindowSecCfg > maxSolRefundWindowSecCfg) {
    die('Invalid Solana refund window range (min > max)');
  }
  if (maxPlatformFeeBpsCfg > 500) die('Invalid --max-platform-fee-bps (must be <= 500)');
  if (maxTradeFeeBpsCfg > 1000) die('Invalid --max-trade-fee-bps (must be <= 1000)');
  if (maxTotalFeeBpsCfg > 1500) die('Invalid --max-total-fee-bps (must be <= 1500)');

  // The actual RFQ we post uses these variables. When listening to offers, they can be overridden
  // (but still constrained by the configured guardrails above).
  let minSolRefundWindowSec = minSolRefundWindowSecCfg;
  let maxSolRefundWindowSec = maxSolRefundWindowSecCfg;
  let maxPlatformFeeBps = maxPlatformFeeBpsCfg;
  let maxTradeFeeBps = maxTradeFeeBpsCfg;
  let maxTotalFeeBps = maxTotalFeeBpsCfg;

  const solRpcUrl = (flags.get('solana-rpc-url') && String(flags.get('solana-rpc-url')).trim()) || 'http://127.0.0.1:8899';
  const solKeypairPath = flags.get('solana-keypair') ? String(flags.get('solana-keypair')).trim() : '';
  const solMintStr = flags.get('solana-mint') ? String(flags.get('solana-mint')).trim() : '';
  const solProgramIdStr = flags.get('solana-program-id') ? String(flags.get('solana-program-id')).trim() : '';
  const solComputeUnitLimit = parseIntFlag(flags.get('solana-cu-limit'), 'solana-cu-limit', null);
  const solComputeUnitPriceMicroLamports = parseIntFlag(flags.get('solana-cu-price'), 'solana-cu-price', null);

  const lnImpl = (flags.get('ln-impl') && String(flags.get('ln-impl')).trim().toLowerCase()) || 'cln';
  if (lnImpl !== 'cln' && lnImpl !== 'lnd') die('Invalid --ln-impl (expected cln|lnd)');
  const lnBackend = (flags.get('ln-backend') && String(flags.get('ln-backend')).trim()) || 'docker';
  const lnComposeFile = (flags.get('ln-compose-file') && String(flags.get('ln-compose-file')).trim()) || defaultComposeFile;
  const lnService = flags.get('ln-service') ? String(flags.get('ln-service')).trim() : '';
  const lnNetworkRaw = (flags.get('ln-network') && String(flags.get('ln-network')).trim()) || 'regtest';
  let lnNetwork;
  try {
    lnNetwork = lnImpl === 'lnd' ? normalizeLndNetwork(lnNetworkRaw) : normalizeClnNetwork(lnNetworkRaw);
  } catch (err) {
    die(err?.message ?? String(err));
  }
  const lnCliBin = flags.get('ln-cli-bin') ? String(flags.get('ln-cli-bin')).trim() : '';
  const lndRpcserver = flags.get('lnd-rpcserver') ? String(flags.get('lnd-rpcserver')).trim() : '';
  const lndTlsCert = flags.get('lnd-tlscert') ? String(flags.get('lnd-tlscert')).trim() : '';
  const lndMacaroon = flags.get('lnd-macaroon') ? String(flags.get('lnd-macaroon')).trim() : '';
  const lndDir = flags.get('lnd-dir') ? String(flags.get('lnd-dir')).trim() : '';

  const expectedProgramId = solProgramIdStr ? new PublicKey(solProgramIdStr) : LN_USDT_ESCROW_PROGRAM_ID;
  const expectedAppHash = deriveIntercomswapAppHash({ solanaProgramId: expectedProgramId.toBase58() });

  const receipts = receiptsDbPath ? openTradeReceiptsStore({ dbPath: receiptsDbPath }) : null;

  if (runSwap) {
    if (!solKeypairPath) die('Missing --solana-keypair (required when --run-swap 1)');
    if (!lnService && lnBackend === 'docker') die('Missing --ln-service (required when --ln-backend docker)');
  }

  const ln = {
    impl: lnImpl,
    backend: lnBackend,
    composeFile: lnComposeFile,
    service: lnService,
    network: lnNetwork,
    cliBin: lnCliBin,
    cwd: repoRoot,
    lnd: {
      rpcserver: lndRpcserver,
      tlscertpath: lndTlsCert,
      macaroonpath: lndMacaroon,
      lnddir: lndDir,
    },
  };

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();

  const joinedChannels = Array.from(new Set([rfqChannel, ...(listenOffers ? offerChannels : [])]));
  for (const ch of joinedChannels) {
    ensureOk(await sc.join(ch), `join ${ch}`);
  }
  ensureOk(await sc.subscribe(joinedChannels), `subscribe ${joinedChannels.join(',')}`);

  const takerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!takerPubkey) die('SC-Bridge hello missing peer pubkey');
  const signing = await loadPeerWalletFromFile(peerKeypairPath);
  if (signing.pubHex !== takerPubkey) {
    die(`peer keypair pubkey mismatch: sc_bridge=${takerPubkey} keypair=${signing.pubHex}`);
  }

  const persistTrade = (patch, eventKind = null, eventPayload = null) => {
    if (!receipts) return;
    try {
      receipts.upsertTrade(tradeId, patch);
      if (eventKind) receipts.appendEvent(tradeId, eventKind, eventPayload);
    } catch (err) {
      try {
        receipts.upsertTrade(tradeId, { last_error: err?.message ?? String(err) });
      } catch (_e) {}
      if (debug) process.stderr.write(`[taker] receipts persist error: ${err?.message ?? String(err)}\n`);
    }
  };

  const sol = runSwap
    ? (() => {
        const payer = readSolanaKeypair(solKeypairPath);
        const pool = new SolanaRpcPool({ rpcUrls: solRpcUrl, commitment: 'confirmed' });
        return {
          payer,
          pool,
          expectedProgramId,
          computeUnitLimit: solComputeUnitLimit,
          computeUnitPriceMicroLamports: solComputeUnitPriceMicroLamports,
        };
      })()
    : null;

  let offerMeta = null;
  if (listenOffers) {
    const offerWaitMs = Math.max(5_000, Math.trunc(Number(timeoutSec || 30) * 1000));
    process.stdout.write(
      `${JSON.stringify({ type: 'waiting_offer', offer_channels: offerChannels, rfq_channel: rfqChannel, trade_id: tradeId, pubkey: takerPubkey })}\n`
    );

    offerMeta = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error(`offer wait timeout after ${offerWaitMs}ms`));
      }, offerWaitMs);

      const cleanup = () => {
        clearTimeout(deadline);
        sc.off('sidechannel_message', onMsg);
      };

      const onMsg = (evt) => {
        try {
          if (!evt || evt.type !== 'sidechannel_message') return;
          if (!offerChannels.includes(String(evt.channel || ''))) return;
          const msg = evt.message;
          if (!msg || typeof msg !== 'object') return;
          if (msg.kind !== KIND.SVC_ANNOUNCE) return;
          const v = validateSwapEnvelope(msg);
          if (!v.ok) return;
          const body = msg.body;
          if (!body || typeof body !== 'object') return;

          const now = Math.floor(Date.now() / 1000);
          const until = Number(body.valid_until_unix);
          if (Number.isFinite(until) && until <= now) return;

          // If the maker included rfq_channels, ensure ours is included to minimize chatter.
          if (Array.isArray(body.rfq_channels) && body.rfq_channels.length > 0) {
            const set = new Set(body.rfq_channels.map((c) => String(c || '').trim()).filter(Boolean));
            if (!set.has(rfqChannel)) return;
          }

          const offers = Array.isArray(body.offers) ? body.offers : [];
          if (offers.length < 1) return;

          for (const o of offers) {
            if (!o || typeof o !== 'object') continue;
            if (String(o.pair || '') !== PAIR.BTC_LN__USDT_SOL) continue;
            if (String(o.have || '') !== ASSET.USDT_SOL) continue;
            if (String(o.want || '') !== ASSET.BTC_LN) continue;

            const appHash = String(o.app_hash || body.app_hash || '').trim().toLowerCase();
            if (!appHash || appHash !== expectedAppHash) continue;

            const btc = Number(o.btc_sats);
            if (!Number.isInteger(btc) || btc < 1) continue;
            const usdt = String(o.usdt_amount || '').trim();
            if (!/^[0-9]+$/.test(usdt)) continue;
            if (BigInt(usdt) <= 0n) continue;

            const maxPlat = Number(o.max_platform_fee_bps);
            const maxTrade = Number(o.max_trade_fee_bps);
            const maxTotal = Number(o.max_total_fee_bps);
            if (!Number.isInteger(maxPlat) || maxPlat < 0 || maxPlat > 500) continue;
            if (!Number.isInteger(maxTrade) || maxTrade < 0 || maxTrade > 1000) continue;
            if (!Number.isInteger(maxTotal) || maxTotal < 0 || maxTotal > 1500) continue;
            if (maxPlat > maxPlatformFeeBpsCfg) continue;
            if (maxTrade > maxTradeFeeBpsCfg) continue;
            if (maxTotal > maxTotalFeeBpsCfg) continue;

            const minWin = Number(o.min_sol_refund_window_sec);
            const maxWin = Number(o.max_sol_refund_window_sec);
            if (!Number.isInteger(minWin) || minWin < SOL_REFUND_MIN_SEC || minWin > SOL_REFUND_MAX_SEC) continue;
            if (!Number.isInteger(maxWin) || maxWin < SOL_REFUND_MIN_SEC || maxWin > SOL_REFUND_MAX_SEC) continue;
            if (minWin > maxWin) continue;
            if (minWin < minSolRefundWindowSecCfg) continue;
            if (maxWin > maxSolRefundWindowSecCfg) continue;

            cleanup();
            resolve({
              offer_channel: String(evt.channel || ''),
              offer_name: String(body.name || ''),
              offer_signer: String(msg.signer || '').trim().toLowerCase() || null,
              offer_valid_until_unix: Number.isFinite(until) ? until : null,
              // RFQ mirror values
              btc_sats: btc,
              usdt_amount: usdt,
              max_platform_fee_bps: maxPlat,
              max_trade_fee_bps: maxTrade,
              max_total_fee_bps: maxTotal,
              min_sol_refund_window_sec: minWin,
              max_sol_refund_window_sec: maxWin,
            });
            return;
          }
        } catch (err) {
          cleanup();
          reject(err);
        }
      };

      sc.on('sidechannel_message', onMsg);
    });

    btcSats = offerMeta.btc_sats;
    usdtAmount = offerMeta.usdt_amount;
    maxPlatformFeeBps = offerMeta.max_platform_fee_bps;
    maxTradeFeeBps = offerMeta.max_trade_fee_bps;
    maxTotalFeeBps = offerMeta.max_total_fee_bps;
    minSolRefundWindowSec = offerMeta.min_sol_refund_window_sec;
    maxSolRefundWindowSec = offerMeta.max_sol_refund_window_sec;

    process.stdout.write(
      `${JSON.stringify({
        type: 'offer_matched',
        trade_id: tradeId,
        offer_channel: offerMeta.offer_channel,
        offer_name: offerMeta.offer_name,
        btc_sats: btcSats,
        usdt_amount: usdtAmount,
      })}\n`
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let rfqValidUntil = nowSec + rfqValidSec;
  if (offerMeta && Number.isFinite(offerMeta.offer_valid_until_unix) && offerMeta.offer_valid_until_unix > 0) {
    rfqValidUntil = Math.min(rfqValidUntil, Math.trunc(offerMeta.offer_valid_until_unix));
  }
  if (!Number.isInteger(Number(btcSats)) || Number(btcSats) < 1) {
    die('Invalid --btc-sats (must be >= 1)');
  }
  if (!/^[0-9]+$/.test(String(usdtAmount || '').trim()) || BigInt(String(usdtAmount || '0')) <= 0n) {
    die('Invalid --usdt-amount (must be a positive base-unit integer; open RFQ amount=0 is not supported)');
  }
  const rfqUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: expectedAppHash,
      btc_sats: btcSats,
      usdt_amount: usdtAmount,
      // Pre-filtering: tell makers our fee ceilings up front (binding fees are still in TERMS).
      max_platform_fee_bps: maxPlatformFeeBps,
      max_trade_fee_bps: maxTradeFeeBps,
      max_total_fee_bps: maxTotalFeeBps,
      // Pre-filtering: request a Solana refund/claim window range (seconds).
      // Maker will advertise its offered value in QUOTE.sol_refund_window_sec.
      min_sol_refund_window_sec: minSolRefundWindowSec,
      max_sol_refund_window_sec: maxSolRefundWindowSec,
      ...(runSwap ? { sol_recipient: sol.payer.publicKey.toBase58() } : {}),
      ...(runSwap && solMintStr ? { sol_mint: solMintStr } : {}),
      valid_until_unix: rfqValidUntil,
    },
  });
  const rfqId = hashUnsignedEnvelope(rfqUnsigned);
  const rfqSigned = signSwapEnvelope(rfqUnsigned, signing);
  ensureOk(await sc.send(rfqChannel, rfqSigned), 'send rfq');

  persistTrade(
    {
      role: 'taker',
      rfq_channel: rfqChannel,
      maker_peer: null,
      taker_peer: takerPubkey,
      btc_sats: btcSats,
      usdt_amount: usdtAmount,
      sol_mint: runSwap && solMintStr ? solMintStr : null,
      sol_recipient: runSwap ? sol.payer.publicKey.toBase58() : null,
      state: STATE.INIT,
    },
    'rfq_sent',
    rfqSigned
  );

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'taker', rfq_channel: rfqChannel, trade_id: tradeId, rfq_id: rfqId, pubkey: takerPubkey })}\n`);

  let chosen = null; // { rfq_id, quote_id, quote }
  let joined = false;
  let joinSwapInFlight = false;
  let done = false;
  let swapCtx = null; // { swapChannel, invite, trade, waiters, sent }

  const deadlineMs = Date.now() + timeoutSec * 1000;

  const maybeExit = () => {
    if (!once) return;
    if (!done) return;
    const delay = Number.isFinite(onceExitDelayMs) ? Math.max(onceExitDelayMs, 0) : 0;
    setTimeout(() => {
      try {
        receipts?.close();
      } catch (_e) {}
      sc.close();
      process.exit(0);
    }, delay);
  };

  const leaveSidechannel = async (channel) => {
    try {
      await sc.leave(channel);
    } catch (_e) {}
  };

  const resendRfqTimer = setInterval(async () => {
    try {
      if (chosen) return;
      if (Date.now() > deadlineMs) return;
      ensureOk(await sc.send(rfqChannel, rfqSigned), 'resend rfq');
      if (debug) process.stderr.write(`[taker] resend rfq trade_id=${tradeId}\n`);
    } catch (err) {
      if (debug) process.stderr.write(`[taker] resend rfq error: ${err?.message ?? String(err)}\n`);
    }
  }, Math.max(rfqResendMs, 200));

  let quoteAcceptSigned = null;
  const resendAcceptTimer = setInterval(async () => {
    try {
      if (!chosen) return;
      if (joined) return;
      if (Date.now() > deadlineMs) return;
      if (!quoteAcceptSigned) return;
      ensureOk(await sc.send(rfqChannel, quoteAcceptSigned), 'resend quote_accept');
      if (debug) process.stderr.write(`[taker] resend quote_accept trade_id=${tradeId} quote_id=${chosen.quote_id}\n`);
    } catch (err) {
      if (debug) process.stderr.write(`[taker] resend quote_accept error: ${err?.message ?? String(err)}\n`);
    }
  }, Math.max(acceptResendMs, 200));

  const stopTimers = () => {
    clearInterval(resendRfqTimer);
    clearInterval(resendAcceptTimer);
  };

  const enforceTimeout = setInterval(() => {
    if (Date.now() <= deadlineMs) return;
    stopTimers();
    die(`Timeout waiting for RFQ handshake (timeout-sec=${timeoutSec})`);
  }, 200);

  const waitForSwapMessage = (match, { timeoutMs, label }) =>
    new Promise((resolve, reject) => {
      if (!swapCtx) return reject(new Error('swapCtx not initialized'));
      const timer = setTimeout(() => {
        swapCtx.waiters.delete(waiter);
        reject(new Error(`Timeout waiting for ${label}`));
      }, timeoutMs);
      const waiter = (msg) => {
        try {
          if (!match(msg)) return;
          clearTimeout(timer);
          swapCtx.waiters.delete(waiter);
          resolve(msg);
        } catch (err) {
          clearTimeout(timer);
          swapCtx.waiters.delete(waiter);
          reject(err);
        }
      };
      swapCtx.waiters.add(waiter);
    });

  const ensureAta = async ({ connection, payer, mint, owner }) => {
    const ata = await getAssociatedTokenAddress(mint, owner);
    try {
      await getAccount(connection, ata, 'confirmed');
      return ata;
    } catch (_e) {
      return createAssociatedTokenAccount(connection, payer, mint, owner);
    }
  };

  const startSwap = async ({ swapChannel, invite }) => {
    ensureOk(await sc.subscribe([swapChannel]), `subscribe ${swapChannel}`);

    swapCtx = {
      swapChannel,
      invite,
      trade: createInitialTrade(tradeId),
      waiters: new Set(),
      sent: {},
      done: false,
      deadlineMs: Date.now() + swapTimeoutSec * 1000,
      timers: new Set(),
    };

    persistTrade(
      {
        swap_channel: swapChannel,
        state: swapCtx.trade.state,
      },
      'swap_started',
      { swap_channel: swapChannel }
    );

    const clearTimers = () => {
      for (const tmr of swapCtx.timers) clearInterval(tmr);
      swapCtx.timers.clear();
    };

    const checkSwapDeadline = () => {
      if (Date.now() <= swapCtx.deadlineMs) return;
      clearTimers();
      die(`Timeout waiting for swap completion (swap-timeout-sec=${swapTimeoutSec})`);
    };

    // Send ready status with invite attached to accelerate authorization.
  const readyUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.STATUS,
    tradeId,
    body: { state: STATE.INIT, note: 'ready' },
  });
  const readySigned = signSwapEnvelope(readyUnsigned, signing);
  swapCtx.sent.ready = readySigned;
  await sc.send(swapChannel, readySigned, { invite });
    process.stdout.write(`${JSON.stringify({ type: 'swap_ready_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'swap_ready_sent', readySigned);

    const readyTimer = setInterval(async () => {
      try {
        checkSwapDeadline();
        if (swapCtx.done) return;
        if (swapCtx.trade.state !== STATE.INIT) return;
        await sc.send(swapChannel, readySigned, { invite });
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
    swapCtx.timers.add(readyTimer);

    // Wait for terms.
    const termsMsg = await waitForSwapMessage((m) => m?.kind === KIND.TERMS && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'TERMS',
    });

    const termsAppHash = String(termsMsg?.body?.app_hash || '').trim().toLowerCase();
    if (termsAppHash !== expectedAppHash) {
      throw new Error('terms.app_hash mismatch (wrong app/program for this channel)');
    }

    // Guardrail: bind swap counterparty identity to the quote we accepted.
    const quoteMaker = String(chosen?.quote?.signer || '').trim().toLowerCase();
    const gotTermsSigner = String(termsMsg.signer || '').trim().toLowerCase();
    if (quoteMaker && gotTermsSigner && quoteMaker !== gotTermsSigner) {
      throw new Error(`terms signer mismatch vs quote signer (terms=${gotTermsSigner} quote=${quoteMaker})`);
    }
    const termsReceiver = String(termsMsg.body?.ln_receiver_peer || '').trim().toLowerCase();
    if (quoteMaker && termsReceiver && quoteMaker !== termsReceiver) {
      throw new Error(`terms.ln_receiver_peer mismatch vs quote signer (terms=${termsReceiver} quote=${quoteMaker})`);
    }
    const termsPayer = String(termsMsg.body?.ln_payer_peer || '').trim().toLowerCase();
    if (termsPayer && termsPayer !== takerPubkey) {
      throw new Error(`terms.ln_payer_peer mismatch vs our pubkey (terms=${termsPayer} want=${takerPubkey})`);
    }

    // Verify Solana recipient matches our keypair before proceeding.
    const wantRecipient = sol.payer.publicKey.toBase58();
    const gotRecipient = String(termsMsg.body?.sol_recipient || '');
    if (gotRecipient !== wantRecipient) {
      throw new Error(`terms.sol_recipient mismatch (got=${gotRecipient} want=${wantRecipient})`);
    }
    if (solMintStr) {
      const gotMint = String(termsMsg.body?.sol_mint || '');
      if (gotMint !== solMintStr) throw new Error(`terms.sol_mint mismatch (got=${gotMint} want=${solMintStr})`);
    }

    if (minSolRefundWindowSec !== null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const refundAfterUnix = Number(termsMsg.body?.sol_refund_after_unix);
      if (!Number.isFinite(refundAfterUnix) || refundAfterUnix <= 0) {
        throw new Error('terms.sol_refund_after_unix missing/invalid');
      }
      const termsTsSec = Math.floor(Number(termsMsg?.ts || 0) / 1000) || nowSec;
      const windowSec = refundAfterUnix - termsTsSec;
      // Allow small clock skew / rounding differences between unix-sec and ms timestamps.
      const slackSec = 120;
      if (windowSec + slackSec < minSolRefundWindowSec) {
        throw new Error(
          `terms.sol_refund_after_unix too soon (window_sec=${windowSec} min=${minSolRefundWindowSec})`
        );
      }
      if (
        maxSolRefundWindowSec !== null &&
        Number.isFinite(maxSolRefundWindowSec) &&
        windowSec - slackSec > maxSolRefundWindowSec
      ) {
        throw new Error(
          `terms.sol_refund_after_unix too far (window_sec=${windowSec} max=${maxSolRefundWindowSec})`
        );
      }
    }

    // Guardrail: terms must match the quote we accepted (prevents bait-and-switch between RFQ and swap channel).
    if (chosen?.quote?.body) {
      if (Number(termsMsg.body?.btc_sats) !== Number(chosen.quote.body?.btc_sats)) {
        throw new Error(
          `terms.btc_sats mismatch vs quote (terms=${termsMsg.body?.btc_sats} quote=${chosen.quote.body?.btc_sats})`
        );
      }
      if (String(termsMsg.body?.usdt_amount) !== String(chosen.quote.body?.usdt_amount)) {
        throw new Error(
          `terms.usdt_amount mismatch vs quote (terms=${termsMsg.body?.usdt_amount} quote=${chosen.quote.body?.usdt_amount})`
        );
      }
      if (chosen.quote.body?.sol_mint) {
        if (String(termsMsg.body?.sol_mint) !== String(chosen.quote.body?.sol_mint)) {
          throw new Error(
            `terms.sol_mint mismatch vs quote (terms=${termsMsg.body?.sol_mint} quote=${chosen.quote.body?.sol_mint})`
          );
        }
      }
      if (chosen.quote.body?.sol_refund_window_sec !== undefined && chosen.quote.body?.sol_refund_window_sec !== null) {
        const quoteWindow = Number(chosen.quote.body?.sol_refund_window_sec);
        const refundAfterUnix = Number(termsMsg.body?.sol_refund_after_unix);
        const termsTsSec = Math.floor(Number(termsMsg?.ts || 0) / 1000);
        if (Number.isFinite(quoteWindow) && quoteWindow > 0 && Number.isFinite(refundAfterUnix) && refundAfterUnix > 0 && termsTsSec > 0) {
          const termsWindow = refundAfterUnix - termsTsSec;
          // Allow small clock skew / rounding differences.
          if (Math.abs(termsWindow - quoteWindow) > 120) {
            throw new Error(
              `terms.sol_refund_after_unix mismatch vs quote window (terms_window_sec=${termsWindow} quote_window_sec=${quoteWindow})`
            );
          }
        }
      }
      if (chosen.quote.body?.platform_fee_bps !== undefined && chosen.quote.body?.platform_fee_bps !== null) {
        if (Number(termsMsg.body?.platform_fee_bps) !== Number(chosen.quote.body?.platform_fee_bps)) {
          throw new Error(
            `terms.platform_fee_bps mismatch vs quote (terms=${termsMsg.body?.platform_fee_bps} quote=${chosen.quote.body?.platform_fee_bps})`
          );
        }
      }
      if (chosen.quote.body?.trade_fee_bps !== undefined && chosen.quote.body?.trade_fee_bps !== null) {
        if (Number(termsMsg.body?.trade_fee_bps) !== Number(chosen.quote.body?.trade_fee_bps)) {
          throw new Error(
            `terms.trade_fee_bps mismatch vs quote (terms=${termsMsg.body?.trade_fee_bps} quote=${chosen.quote.body?.trade_fee_bps})`
          );
        }
      }
      if (chosen.quote.body?.trade_fee_collector) {
        if (String(termsMsg.body?.trade_fee_collector) !== String(chosen.quote.body?.trade_fee_collector)) {
          throw new Error(
            `terms.trade_fee_collector mismatch vs quote (terms=${termsMsg.body?.trade_fee_collector} quote=${chosen.quote.body?.trade_fee_collector})`
          );
        }
      }
      if (chosen.quote.body?.platform_fee_collector && termsMsg.body?.platform_fee_collector) {
        if (String(termsMsg.body?.platform_fee_collector) !== String(chosen.quote.body?.platform_fee_collector)) {
          throw new Error(
            `terms.platform_fee_collector mismatch vs quote (terms=${termsMsg.body?.platform_fee_collector} quote=${chosen.quote.body?.platform_fee_collector})`
          );
        }
      }
    }

    // Guardrail: fee ceilings (local policy; on-chain also enforces hard caps).
    const platformFeeBps = Number(termsMsg.body?.platform_fee_bps || 0);
    const tradeFeeBps = Number(termsMsg.body?.trade_fee_bps || 0);
    if (!Number.isFinite(platformFeeBps) || platformFeeBps < 0) throw new Error('terms.platform_fee_bps invalid');
    if (!Number.isFinite(tradeFeeBps) || tradeFeeBps < 0) throw new Error('terms.trade_fee_bps invalid');
    if (platformFeeBps > maxPlatformFeeBps) {
      throw new Error(`terms.platform_fee_bps too high (got=${platformFeeBps} max=${maxPlatformFeeBps})`);
    }
    if (tradeFeeBps > maxTradeFeeBps) {
      throw new Error(`terms.trade_fee_bps too high (got=${tradeFeeBps} max=${maxTradeFeeBps})`);
    }
    if (platformFeeBps + tradeFeeBps > maxTotalFeeBps) {
      throw new Error(
        `terms total fee too high (got=${platformFeeBps + tradeFeeBps} max=${maxTotalFeeBps})`
      );
    }

    const termsHash = hashUnsignedEnvelope(stripSignature(termsMsg));
  const acceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.ACCEPT,
    tradeId,
    body: { terms_hash: termsHash },
  });
  const acceptSigned = signSwapEnvelope(acceptUnsigned, signing);
  {
    const r = applySwapEnvelope(swapCtx.trade, acceptSigned);
    if (!r.ok) throw new Error(r.error);
    swapCtx.trade = r.trade;
  }
    swapCtx.sent.accept = acceptSigned;
    await sc.send(swapChannel, acceptSigned);
    process.stdout.write(`${JSON.stringify({ type: 'accept_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'accept_sent', acceptSigned);

    const acceptTimer = setInterval(async () => {
      try {
        checkSwapDeadline();
        if (swapCtx.done) return;
        if (swapCtx.trade.state !== STATE.ACCEPTED && swapCtx.trade.state !== STATE.INIT && swapCtx.trade.state !== STATE.TERMS) return;
        if (swapCtx.trade.invoice) return;
        await sc.send(swapChannel, acceptSigned);
      } catch (_e) {}
    }, Math.max(swapResendMs, 200));
    swapCtx.timers.add(acceptTimer);

    // Wait for invoice + escrow proof.
    await waitForSwapMessage((m) => m?.kind === KIND.LN_INVOICE && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'LN_INVOICE',
    });
    await waitForSwapMessage((m) => m?.kind === KIND.SOL_ESCROW_CREATED && m?.trade_id === tradeId, {
      timeoutMs: swapTimeoutSec * 1000,
      label: 'SOL_ESCROW_CREATED',
    });

    if (swapCtx.trade.invoice) {
      persistTrade(
        {
          ln_invoice_bolt11: swapCtx.trade.invoice.bolt11,
          ln_payment_hash_hex: swapCtx.trade.invoice.payment_hash_hex,
          state: swapCtx.trade.state,
        },
        'ln_invoice_recv',
        swapCtx.trade.invoice
      );
    }
    if (swapCtx.trade.escrow) {
      if (sol?.expectedProgramId) {
        const gotProgram = String(swapCtx.trade.escrow.program_id || '').trim();
        const wantProgram = sol.expectedProgramId.toBase58();
        if (!gotProgram) throw new Error('escrow.program_id missing');
        if (gotProgram !== wantProgram) {
          throw new Error(`escrow.program_id mismatch (got=${gotProgram} want=${wantProgram})`);
        }
      }
      persistTrade(
        {
          sol_program_id: swapCtx.trade.escrow.program_id,
          sol_mint: swapCtx.trade.escrow.mint,
          sol_recipient: swapCtx.trade.escrow.recipient,
          sol_refund: swapCtx.trade.escrow.refund,
          sol_escrow_pda: swapCtx.trade.escrow.escrow_pda,
          sol_vault_ata: swapCtx.trade.escrow.vault_ata,
          sol_refund_after_unix: swapCtx.trade.escrow.refund_after_unix,
          state: swapCtx.trade.state,
        },
        'sol_escrow_recv',
        swapCtx.trade.escrow
      );
    }

    // Hard rule: verify escrow on-chain before paying.
    const prepay = await sol.pool.call(
      (connection) =>
        verifySwapPrePayOnchain({
          terms: swapCtx.trade.terms,
          invoiceBody: swapCtx.trade.invoice,
          escrowBody: swapCtx.trade.escrow,
          connection,
          now_unix: Math.floor(Date.now() / 1000),
        }),
      { label: 'taker:verify-prepay' }
    );
    if (!prepay.ok) throw new Error(`verify-prepay failed: ${prepay.error}`);
    // Defense-in-depth: ensure the on-chain escrow fee receiver settings match the negotiated TERMS, otherwise
    // claim could fail (wrong trade fee vault PDA) or fees could be misrepresented.
    if (prepay?.onchain?.state?.v === 3) {
      const st = prepay.onchain.state;
      const wantTradeFeeCollector = String(swapCtx.trade.terms?.trade_fee_collector || '').trim();
      if (wantTradeFeeCollector && st.tradeFeeCollector?.toBase58?.() !== wantTradeFeeCollector) {
        throw new Error(
          `onchain tradeFeeCollector mismatch vs terms (state=${st.tradeFeeCollector.toBase58()} terms=${wantTradeFeeCollector})`
        );
      }
      const wantTradeFeeBps = Number(swapCtx.trade.terms?.trade_fee_bps || 0);
      if (Number.isFinite(wantTradeFeeBps) && Number(st.tradeFeeBps) !== wantTradeFeeBps) {
        throw new Error(`onchain tradeFeeBps mismatch vs terms (state=${st.tradeFeeBps} terms=${wantTradeFeeBps})`);
      }
      const wantPlatformFeeCollector = String(swapCtx.trade.terms?.platform_fee_collector || '').trim();
      if (wantPlatformFeeCollector && st.platformFeeCollector?.toBase58?.() !== wantPlatformFeeCollector) {
        throw new Error(
          `onchain platformFeeCollector mismatch vs terms (state=${st.platformFeeCollector.toBase58()} terms=${wantPlatformFeeCollector})`
        );
      }
      const wantPlatformFeeBps = Number(swapCtx.trade.terms?.platform_fee_bps || 0);
      if (Number.isFinite(wantPlatformFeeBps) && Number(st.platformFeeBps) !== wantPlatformFeeBps) {
        throw new Error(`onchain platformFeeBps mismatch vs terms (state=${st.platformFeeBps} terms=${wantPlatformFeeBps})`);
      }
    }

    // Pay LN invoice and obtain preimage.
    const payRes = await lnPay(ln, { bolt11: swapCtx.trade.invoice.bolt11 });
    const preimageHex = String(payRes?.payment_preimage || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error('LN pay missing payment_preimage');

    const paymentHashHex = String(swapCtx.trade.invoice.payment_hash_hex || '').trim().toLowerCase();

  const lnPaidUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.LN_PAID,
    tradeId,
    body: { payment_hash_hex: paymentHashHex },
  });
  const lnPaidSigned = signSwapEnvelope(lnPaidUnsigned, signing);
  {
    const r = applySwapEnvelope(swapCtx.trade, lnPaidSigned);
    if (!r.ok) throw new Error(r.error);
    swapCtx.trade = r.trade;
  }
    swapCtx.sent.ln_paid = lnPaidSigned;
    await sc.send(swapChannel, lnPaidSigned);
    process.stdout.write(`${JSON.stringify({ type: 'ln_paid_sent', trade_id: tradeId, swap_channel: swapChannel })}\n`);

    persistTrade(
      {
        ln_payment_hash_hex: paymentHashHex,
        ln_preimage_hex: persistPreimage ? preimageHex : null,
        state: swapCtx.trade.state,
      },
      'ln_paid',
      { payment_hash_hex: paymentHashHex }
    );

    if (stopAfterLnPay) {
      // Recovery path: operator can claim via `scripts/swaprecover.mjs claim ...`.
      swapCtx.done = true;
      done = true;
      clearTimers();
      process.stdout.write(`${JSON.stringify({ type: 'stopped_after_ln_pay', trade_id: tradeId, swap_channel: swapChannel })}\n`);
      await leaveSidechannel(swapChannel);
      try {
        receipts?.close();
      } catch (_e) {}
      sc.close();
      process.exit(0);
    }

    // Claim escrow on Solana.
    const mint = new PublicKey(swapCtx.trade.terms.sol_mint);
    const recipientToken = await sol.pool.call(
      (connection) =>
        ensureAta({
          connection,
          payer: sol.payer,
          mint,
          owner: sol.payer.publicKey,
        }),
      { label: 'taker:ensure-ata' }
    );
    const programId = swapCtx.trade.escrow?.program_id ? new PublicKey(swapCtx.trade.escrow.program_id) : undefined;
    const tradeFeeCollectorStr = swapCtx.trade.terms?.trade_fee_collector;
    if (!tradeFeeCollectorStr) throw new Error('Missing terms.trade_fee_collector');
    const { tx: claimTx } = await sol.pool.call(
      (connection) =>
        claimEscrowTx({
          connection,
          recipient: sol.payer,
          recipientTokenAccount: recipientToken,
          mint,
          paymentHashHex,
          preimageHex,
          tradeFeeCollector: new PublicKey(String(tradeFeeCollectorStr)),
          computeUnitLimit: sol.computeUnitLimit,
          computeUnitPriceMicroLamports: sol.computeUnitPriceMicroLamports,
          ...(programId ? { programId } : {}),
        }),
      { label: 'taker:build-claim-tx' }
    );
    const claimSig = await sol.pool.call((connection) => sendAndConfirm(connection, claimTx), { label: 'taker:send-claim-tx' });

  const solClaimedUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SOL_CLAIMED,
    tradeId,
    body: {
      payment_hash_hex: paymentHashHex,
      escrow_pda: swapCtx.trade.escrow.escrow_pda,
      tx_sig: claimSig,
    },
  });
  const solClaimedSigned = signSwapEnvelope(solClaimedUnsigned, signing);
  swapCtx.sent.sol_claimed = solClaimedSigned;
  await sc.send(swapChannel, solClaimedSigned);
    process.stdout.write(`${JSON.stringify({ type: 'sol_claimed_sent', trade_id: tradeId, swap_channel: swapChannel, tx_sig: claimSig })}\n`);
    persistTrade({ state: swapCtx.trade.state }, 'sol_claimed', solClaimedSigned);

    // Best-effort: resend final proofs a few times to reduce "sent but peer exited" flakiness.
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        await sc.send(swapChannel, solClaimedSigned);
      } catch (_e) {}
    }

    swapCtx.done = true;
    done = true;
    clearTimers();
    process.stdout.write(`${JSON.stringify({ type: 'swap_done', trade_id: tradeId, swap_channel: swapChannel })}\n`);
    persistTrade({ state: STATE.CLAIMED }, 'swap_done', { trade_id: tradeId, swap_channel: swapChannel });
    await leaveSidechannel(swapChannel);
    maybeExit();
  };

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (swapCtx && evt?.channel === swapCtx.swapChannel) {
        const msg = evt?.message;
        if (!msg || typeof msg !== 'object') return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const r = applySwapEnvelope(swapCtx.trade, msg);
        if (r.ok) swapCtx.trade = r.trade;
        for (const waiter of swapCtx.waiters) {
          try {
            waiter(msg);
          } catch (_e) {}
        }
        return;
      }

      if (evt?.channel !== rfqChannel) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;

      if (msg.kind === KIND.QUOTE) {
        if (String(msg.trade_id) !== tradeId) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const quoteAppHash = String(msg?.body?.app_hash || '').trim().toLowerCase();
        if (quoteAppHash !== expectedAppHash) return;
        const quoteUnsigned = stripSignature(msg);
        const quoteId = hashUnsignedEnvelope(quoteUnsigned);
        const rfqIdGot = String(msg.body?.rfq_id || '').trim().toLowerCase();
        if (rfqIdGot !== rfqId) return;

        const validUntil = Number(msg.body?.valid_until_unix);
        const now = Math.floor(Date.now() / 1000);
        if (Number.isFinite(validUntil) && validUntil <= now) {
          if (debug) process.stderr.write(`[taker] ignore expired quote quote_id=${quoteId}\n`);
          return;
        }

        // Pre-filtering: require explicit fee preview in QUOTE so we can reject before joining swap:<id>.
        const quotePlatformFeeBps = Number(msg.body?.platform_fee_bps);
        const quoteTradeFeeBps = Number(msg.body?.trade_fee_bps);
        if (!Number.isFinite(quotePlatformFeeBps) || quotePlatformFeeBps < 0) return;
        if (!Number.isFinite(quoteTradeFeeBps) || quoteTradeFeeBps < 0) return;
        if (quotePlatformFeeBps > maxPlatformFeeBps) return;
        if (quoteTradeFeeBps > maxTradeFeeBps) return;
        if (quotePlatformFeeBps + quoteTradeFeeBps > maxTotalFeeBps) return;

        // Pre-filtering: require explicit refund/claim window advertised in QUOTE (seconds).
        const quoteRefundWindowSec = Number(msg.body?.sol_refund_window_sec);
        if (!Number.isFinite(quoteRefundWindowSec) || quoteRefundWindowSec <= 0) return;
        if (quoteRefundWindowSec < minSolRefundWindowSec) return;
        if (maxSolRefundWindowSec !== null && Number.isFinite(maxSolRefundWindowSec) && quoteRefundWindowSec > maxSolRefundWindowSec) {
          return;
        }

        if (!chosen) {
          // Guardrail: only accept quotes for the exact requested size.
          if (Number(msg.body?.btc_sats) !== Number(btcSats)) return;

          const quoteAmountStr = String(msg.body?.usdt_amount || '').trim();
          const quoteAmount = asBigIntAmount(quoteAmountStr);
          if (quoteAmount === null) return;

          // Guardrail: treat RFQ usdt_amount as a minimum when set (>0).
          const rfqMin = asBigIntAmount(usdtAmount) ?? 0n;
          if (rfqMin > 0n && quoteAmount < rfqMin) return;

          chosen = { rfq_id: rfqId, quote_id: quoteId, quote: msg };
          const quoteAcceptUnsigned = createUnsignedEnvelope({
            v: 1,
            kind: KIND.QUOTE_ACCEPT,
            tradeId,
            body: {
              rfq_id: rfqId,
              quote_id: quoteId,
            },
          });
          quoteAcceptSigned = signSwapEnvelope(quoteAcceptUnsigned, signing);
          ensureOk(await sc.send(rfqChannel, quoteAcceptSigned), 'send quote_accept');
          if (debug) process.stderr.write(`[taker] accepted quote trade_id=${tradeId} quote_id=${quoteId}\n`);
          process.stdout.write(`${JSON.stringify({ type: 'quote_accepted', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId })}\n`);

          persistTrade({ state: STATE.INIT }, 'quote_accepted', quoteAcceptSigned);
        }
        return;
      }

      if (msg.kind === KIND.SWAP_INVITE) {
        if (String(msg.trade_id) !== tradeId) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        if (!chosen) return;
        if (String(msg.body?.rfq_id || '').trim().toLowerCase() !== chosen.rfq_id) return;
        if (String(msg.body?.quote_id || '').trim().toLowerCase() !== chosen.quote_id) return;

        // Guardrail: only accept swap invites from the same maker that authored the quote we accepted.
        const quoteMaker = String(chosen?.quote?.signer || '').trim().toLowerCase();
        const ownerPubkey = String(msg.body?.owner_pubkey || '').trim().toLowerCase();
        const inviterPubkey = String(msg.body?.invite?.payload?.inviterPubKey || '').trim().toLowerCase();
        const inviteMaker = ownerPubkey || inviterPubkey;
        if (quoteMaker && inviteMaker && inviteMaker !== quoteMaker) return;

        const swapChannel = String(msg.body?.swap_channel || '').trim();
        if (!swapChannel) return;

        const invite = msg.body?.invite || null;
        const welcome = msg.body?.welcome || null;

        // Best-effort: ensure the invite is for us (defense-in-depth).
        const invitee = String(invite?.payload?.inviteePubKey || '').trim().toLowerCase();
        if (invitee && invitee !== takerPubkey) return;

        // Dedupe: SWAP_INVITE can be re-broadcast. Never restart the swap state machine.
        if (joined || swapCtx || joinSwapInFlight) {
          if (debug) process.stderr.write(`[taker] ignore duplicate swap_invite trade_id=${tradeId}\n`);
          return;
        }
        joinSwapInFlight = true;
        try {
          ensureOk(await sc.join(swapChannel, { invite, welcome }), `join ${swapChannel}`);
        } finally {
          joinSwapInFlight = false;
        }
        joined = true;
        stopTimers();
        clearInterval(enforceTimeout);
        process.stdout.write(`${JSON.stringify({ type: 'swap_joined', trade_id: tradeId, swap_channel: swapChannel })}\n`);

        persistTrade(
          {
            swap_channel: swapChannel,
            maker_peer: msg.body?.owner_pubkey ? String(msg.body.owner_pubkey).trim().toLowerCase() : null,
          },
          'swap_joined',
          { swap_channel: swapChannel }
        );

        if (!runSwap) {
          if (once) await leaveSidechannel(swapChannel);
          done = true;
          maybeExit();
          return;
        }

        // Swap state machine is run asynchronously; the process stays alive.
        startSwap({ swapChannel, invite }).catch(async (err) => {
          await leaveSidechannel(swapChannel);
          die(err?.stack || err?.message || String(err));
        });
      }
    } catch (err) {
      if (debug) process.stderr.write(`[taker] error: ${err?.message ?? String(err)}\n`);
    }
  });

  // Keep process alive.
  await new Promise(() => {});
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
