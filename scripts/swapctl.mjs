#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature } from '../src/protocol/signedMessage.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { KIND, ASSET, PAIR } from '../src/swap/constants.js';
import { hashTermsEnvelope } from '../src/swap/terms.js';
import {
  createSignedInvite,
  normalizeInvitePayload,
  normalizeWelcomePayload,
  toB64Json,
} from '../src/sidechannel/capabilities.js';

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
swapctl (SC-Bridge sidechannel + swap message helper)

Required connection flags:
  --url <ws://127.0.0.1:49222>
  --token <sc-bridge-token>

Commands:
  stats
  join --channel <name> [--invite <b64|json|@file>] [--welcome <b64|json|@file>]
  open --channel <name> --via <entryChannel> [--invite ...] [--welcome ...]
  send --channel <name> (--text <msg> | --json <obj|@file>)

Invite/Welcome helpers (signed by the peer via SC-Bridge sign):
  make-welcome --channel <name> --text <welcomeText>
  make-invite --channel <name> --invitee-pubkey <hex32> [--ttl-sec <sec>] [--welcome <b64|json|@file>]

Swap message helpers (signed swap envelopes, sent over sidechannels):
  rfq --channel <otcChannel> --trade-id <id> --btc-sats <n> --usdt-amount <atomicStr> [--valid-until-unix <sec>]
  quote --channel <otcChannel> --trade-id <id> --rfq-id <id> --btc-sats <n> --usdt-amount <atomicStr> --valid-until-unix <sec>
  terms --channel <swapChannel> --trade-id <id> --btc-sats <n> --usdt-amount <atomicStr> --sol-mint <base58> --sol-recipient <base58> --sol-refund <base58> --sol-refund-after-unix <sec> --ln-receiver-peer <hex32> --ln-payer-peer <hex32> [--terms-valid-until-unix <sec>]
  accept --channel <swapChannel> --trade-id <id> (--terms-hash <hex> | --terms-json <envelope|@file>)

Notes:
  - This tool never touches private keys; it asks the peer to sign via SC-Bridge.
  - For protected channels, pass the invite/welcome when joining/sending as needed.
`.trim();
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

function readTextMaybeFile(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!v) return '';
  if (v.startsWith('@')) {
    const p = v.slice(1);
    return fs.readFileSync(p, 'utf8');
  }
  return v;
}

function parseJsonOrBase64(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const raw = readTextMaybeFile(value);
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch (_e) {
      return null;
    }
  }
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (_e) {}
  return null;
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function maybeInt(value, label) {
  if (value === undefined || value === null) return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

async function withScBridge({ url, token }, fn) {
  const sc = new ScBridgeClient({ url, token });
  try {
    await sc.connect();
    return await fn(sc);
  } finally {
    sc.close();
  }
}

async function signViaBridge(sc, payload) {
  const res = await sc.sign(payload);
  if (res.type !== 'signed') throw new Error(`Unexpected sign response: ${JSON.stringify(res).slice(0, 120)}`);
  const signerHex = String(res.signer || '').trim().toLowerCase();
  const sigHex = String(res.sig || '').trim().toLowerCase();
  if (!signerHex || !sigHex) throw new Error('Signing failed (missing signer/sig)');
  return { signerHex, sigHex };
}

async function signSwapEnvelope(sc, unsignedEnvelope) {
  const { signerHex, sigHex } = await signViaBridge(sc, unsignedEnvelope);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: signerHex, sigHex });
  const v = validateSwapEnvelope(signed);
  if (!v.ok) throw new Error(`Internal error: signed envelope invalid: ${v.error}`);
  return signed;
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || '';

  if (!cmd || cmd === '--help' || cmd === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');

  if (cmd === 'stats') {
    const res = await withScBridge({ url, token }, (sc) => sc.stats());
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'join') {
    const channel = requireFlag(flags, 'channel');
    const invite = parseJsonOrBase64(flags.get('invite'));
    const welcome = parseJsonOrBase64(flags.get('welcome'));
    const res = await withScBridge({ url, token }, (sc) => sc.join(channel, { invite, welcome }));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'open') {
    const channel = requireFlag(flags, 'channel');
    const via = requireFlag(flags, 'via');
    const invite = parseJsonOrBase64(flags.get('invite'));
    const welcome = parseJsonOrBase64(flags.get('welcome'));
    const res = await withScBridge({ url, token }, (sc) => sc.open(channel, { via, invite, welcome }));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'send') {
    const channel = requireFlag(flags, 'channel');
    const invite = parseJsonOrBase64(flags.get('invite'));
    const welcome = parseJsonOrBase64(flags.get('welcome'));
    const text = flags.get('text');
    const json = flags.get('json');
    if (!text && !json) die('send requires --text or --json');
    if (text && json) die('send requires exactly one of --text or --json');
    const message = text ? String(text) : JSON.parse(readTextMaybeFile(String(json)));
    const res = await withScBridge({ url, token }, (sc) => sc.send(channel, message, { invite, welcome }));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (cmd === 'make-welcome') {
    const channel = requireFlag(flags, 'channel');
    const text = requireFlag(flags, 'text');
    const welcome = await withScBridge({ url, token }, async (sc) => {
      const { signerHex: ownerPubKey } = await signViaBridge(sc, { _probe: 'welcome_owner' });
      const payload = normalizeWelcomePayload({ channel, ownerPubKey, text, issuedAt: Date.now(), version: 1 });
      const { sigHex } = await signViaBridge(sc, payload);
      return { payload, sig: sigHex };
    });
    process.stdout.write(`${JSON.stringify(welcome, null, 2)}\n`);
    process.stdout.write(`welcome_b64=${toB64Json(welcome)}\n`);
    return;
  }

  if (cmd === 'make-invite') {
    const channel = requireFlag(flags, 'channel');
    const inviteePubKey = requireFlag(flags, 'invitee-pubkey').toLowerCase();
    const ttlSec = maybeInt(flags.get('ttl-sec'), 'ttl-sec');
    const welcome = parseJsonOrBase64(flags.get('welcome'));
    const invite = await withScBridge({ url, token }, async (sc) => {
      // Determine inviter pubkey from signer.
      const { signerHex: inviterPubKey } = await signViaBridge(sc, { _probe: 'inviter_pubkey' });
      const issuedAt = Date.now();
      const ttlMs = ttlSec !== null ? ttlSec * 1000 : 7 * 24 * 3600 * 1000;
      const payload = normalizeInvitePayload({
        channel,
        inviteePubKey,
        inviterPubKey,
        inviterAddress: null,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        nonce: Math.random().toString(36).slice(2, 10),
        version: 1,
      });
      const { sigHex } = await signViaBridge(sc, payload);
      return createSignedInvite(payload, () => sigHex, { welcome: welcome || null });
    });
    process.stdout.write(`${JSON.stringify(invite, null, 2)}\n`);
    process.stdout.write(`invite_b64=${toB64Json(invite)}\n`);
    return;
  }

  const sendSigned = async (channel, signedEnvelope, { invite = null, welcome = null } = {}) => {
    const res = await withScBridge({ url, token }, (sc) => sc.send(channel, signedEnvelope, { invite, welcome }));
    if (res.type !== 'sent') throw new Error(`send failed: ${JSON.stringify(res).slice(0, 200)}`);
    return res;
  };

  if (cmd === 'rfq') {
    const channel = requireFlag(flags, 'channel');
    const tradeId = requireFlag(flags, 'trade-id');
    const btcSats = maybeInt(requireFlag(flags, 'btc-sats'), 'btc-sats');
    const usdtAmount = requireFlag(flags, 'usdt-amount');
    const validUntilUnix = maybeInt(flags.get('valid-until-unix'), 'valid-until-unix');

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.RFQ,
      tradeId,
      body: {
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: btcSats,
        usdt_amount: usdtAmount,
        valid_until_unix: validUntilUnix || undefined,
      },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }

  if (cmd === 'quote') {
    const channel = requireFlag(flags, 'channel');
    const tradeId = requireFlag(flags, 'trade-id');
    const rfqId = requireFlag(flags, 'rfq-id');
    const btcSats = maybeInt(requireFlag(flags, 'btc-sats'), 'btc-sats');
    const usdtAmount = requireFlag(flags, 'usdt-amount');
    const validUntilUnix = maybeInt(requireFlag(flags, 'valid-until-unix'), 'valid-until-unix');

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.QUOTE,
      tradeId,
      body: {
        rfq_id: rfqId,
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: btcSats,
        usdt_amount: usdtAmount,
        valid_until_unix: validUntilUnix,
      },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }

  if (cmd === 'terms') {
    const channel = requireFlag(flags, 'channel');
    const tradeId = requireFlag(flags, 'trade-id');
    const btcSats = maybeInt(requireFlag(flags, 'btc-sats'), 'btc-sats');
    const usdtAmount = requireFlag(flags, 'usdt-amount');
    const solMint = requireFlag(flags, 'sol-mint');
    const solRecipient = requireFlag(flags, 'sol-recipient');
    const solRefund = requireFlag(flags, 'sol-refund');
    const solRefundAfter = maybeInt(requireFlag(flags, 'sol-refund-after-unix'), 'sol-refund-after-unix');
    const lnReceiverPeer = requireFlag(flags, 'ln-receiver-peer');
    const lnPayerPeer = requireFlag(flags, 'ln-payer-peer');
    const termsValidUntil = maybeInt(flags.get('terms-valid-until-unix'), 'terms-valid-until-unix');

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.TERMS,
      tradeId,
      body: {
        pair: PAIR.BTC_LN__USDT_SOL,
        direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
        btc_sats: btcSats,
        usdt_amount: usdtAmount,
        usdt_decimals: 6,
        sol_mint: solMint,
        sol_recipient: solRecipient,
        sol_refund: solRefund,
        sol_refund_after_unix: solRefundAfter,
        ln_receiver_peer: lnReceiverPeer,
        ln_payer_peer: lnPayerPeer,
        terms_valid_until_unix: termsValidUntil || undefined,
      },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    process.stdout.write(`terms_hash=${hashTermsEnvelope(signed)}\n`);
    return;
  }

  if (cmd === 'accept') {
    const channel = requireFlag(flags, 'channel');
    const tradeId = requireFlag(flags, 'trade-id');
    const termsHash = flags.get('terms-hash');
    const termsJson = flags.get('terms-json');
    if (!termsHash && !termsJson) die('accept requires --terms-hash or --terms-json');
    if (termsHash && termsJson) die('accept requires exactly one of --terms-hash or --terms-json');
    const hash = termsHash
      ? String(termsHash).trim().toLowerCase()
      : hashTermsEnvelope(JSON.parse(readTextMaybeFile(String(termsJson))));

    const unsigned = createUnsignedEnvelope({
      v: 1,
      kind: KIND.ACCEPT,
      tradeId,
      body: { terms_hash: hash },
    });
    const signed = await withScBridge({ url, token }, (sc) => signSwapEnvelope(sc, unsigned));
    await sendSigned(channel, signed);
    process.stdout.write(`${JSON.stringify(signed, null, 2)}\n`);
    return;
  }

  die(`Unknown command: ${cmd}\n\n${usage()}`);
}

main().catch((err) => {
  const msg = err?.stack || err?.message || String(err);
  die(msg);
});
