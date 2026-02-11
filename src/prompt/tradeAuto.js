import { hashUnsignedEnvelope } from '../swap/hash.js';

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function toIntOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function clampInt(n, { min, max, fallback }) {
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function envelopeKind(evt) {
  return String(evt?.kind || evt?.message?.kind || '').trim();
}

function envelopeTradeId(evt) {
  return String(evt?.trade_id || evt?.message?.trade_id || '').trim();
}

function envelopeSigner(evt) {
  const s = String(evt?.message?.signer || evt?.signer || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/i.test(s) ? s : '';
}

function envelopeSig(evt) {
  const s = String(evt?.message?.sig || '').trim().toLowerCase();
  return /^[0-9a-f]{128}$/i.test(s) ? s : '';
}

function eventTs(evt) {
  const ts = typeof evt?.ts === 'number' ? evt.ts : 0;
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

function isLocalEvent(evt) {
  return Boolean(evt?.local) || String(evt?.dir || '').trim().toLowerCase() === 'out' || String(evt?.origin || '').trim().toLowerCase() === 'local';
}

function stripSignature(envelope) {
  const { sig: _sig, signer: _signer, ...unsigned } = envelope || {};
  return unsigned;
}

function sanitizeChannels(raw) {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((c) => String(c || '').trim())
        .filter((c) => c.length > 0 && c.length <= 128 && !/\s/.test(c))
        .slice(0, 64)
    )
  );
}

function isEventStale(evt, maxAgeMs) {
  const ts = eventTs(evt);
  return Date.now() - ts > maxAgeMs;
}

function pruneSetByLimit(set, limit) {
  const max = Math.max(1, Math.trunc(Number(limit) || 1));
  while (set.size > max) {
    const first = set.values().next().value;
    if (first === undefined) break;
    set.delete(first);
  }
}

function pruneMapByLimit(map, limit) {
  const max = Math.max(1, Math.trunc(Number(limit) || 1));
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

function matchOfferForRfq({ rfqEvt, myOfferEvents }) {
  const rfqMsg = rfqEvt?.message;
  const rfqBody = rfqMsg?.body && typeof rfqMsg.body === 'object' ? rfqMsg.body : null;
  if (!rfqBody) return null;

  const rfqBtc = toIntOrNull(rfqBody.btc_sats);
  const rfqUsdt = String(rfqBody.usdt_amount || '').trim();
  if (rfqBtc === null || rfqBtc < 1 || !/^[0-9]+$/.test(rfqUsdt)) return null;

  const rfqMaxPlatform = Math.max(0, Math.min(500, toIntOrNull(rfqBody.max_platform_fee_bps) ?? 500));
  const rfqMaxTrade = Math.max(0, Math.min(1000, toIntOrNull(rfqBody.max_trade_fee_bps) ?? 1000));
  const rfqMaxTotal = Math.max(0, Math.min(1500, toIntOrNull(rfqBody.max_total_fee_bps) ?? 1500));
  const rfqMinWin = Math.max(3600, Math.min(7 * 24 * 3600, toIntOrNull(rfqBody.min_sol_refund_window_sec) ?? 3600));
  const rfqMaxWin = Math.max(3600, Math.min(7 * 24 * 3600, toIntOrNull(rfqBody.max_sol_refund_window_sec) ?? 7 * 24 * 3600));
  if (rfqMinWin > rfqMaxWin) return null;

  const rfqChannel = String(rfqEvt?.channel || '').trim();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const offerEvt of myOfferEvents) {
    const msg = offerEvt?.message;
    const body = msg?.body && typeof msg.body === 'object' ? msg.body : null;
    if (!body) continue;

    const validUntil = toIntOrNull(body.valid_until_unix);
    if (validUntil !== null && validUntil <= nowSec) continue;

    const rfqChannels = Array.isArray(body.rfq_channels)
      ? body.rfq_channels.map((c) => String(c || '').trim()).filter(Boolean)
      : [];
    if (rfqChannels.length > 0 && rfqChannel && !rfqChannels.includes(rfqChannel)) continue;

    const offers = Array.isArray(body.offers) ? body.offers : [];
    for (const lineRaw of offers) {
      const line = isObject(lineRaw) ? lineRaw : null;
      if (!line) continue;
      const lineBtc = toIntOrNull(line.btc_sats);
      const lineUsdt = String(line.usdt_amount || '').trim();
      if (lineBtc === null || lineBtc < 1 || !/^[0-9]+$/.test(lineUsdt)) continue;
      if (lineBtc !== rfqBtc || lineUsdt !== rfqUsdt) continue;

      const lineMaxPlatform = Math.max(0, Math.min(500, toIntOrNull(line.max_platform_fee_bps) ?? 500));
      const lineMaxTrade = Math.max(0, Math.min(1000, toIntOrNull(line.max_trade_fee_bps) ?? 1000));
      const lineMaxTotal = Math.max(0, Math.min(1500, toIntOrNull(line.max_total_fee_bps) ?? 1500));
      if (lineMaxPlatform > rfqMaxPlatform || lineMaxTrade > rfqMaxTrade || lineMaxTotal > rfqMaxTotal) continue;

      const lineMinWin = Math.max(3600, Math.min(7 * 24 * 3600, toIntOrNull(line.min_sol_refund_window_sec) ?? 3600));
      const lineMaxWin = Math.max(3600, Math.min(7 * 24 * 3600, toIntOrNull(line.max_sol_refund_window_sec) ?? 7 * 24 * 3600));
      const overlapMin = Math.max(rfqMinWin, lineMinWin);
      const overlapMax = Math.min(rfqMaxWin, lineMaxWin);
      if (overlapMin > overlapMax) continue;

      let solRefundWindowSec = 72 * 3600;
      if (solRefundWindowSec < overlapMin) solRefundWindowSec = overlapMin;
      if (solRefundWindowSec > overlapMax) solRefundWindowSec = overlapMax;
      return { solRefundWindowSec };
    }
  }
  return null;
}

export class TradeAutoManager {
  constructor({
    runTool,
    scLogInfo,
    scLogRead,
    logger = null,
  }) {
    if (typeof runTool !== 'function') throw new Error('TradeAutoManager: runTool is required');
    if (typeof scLogInfo !== 'function') throw new Error('TradeAutoManager: scLogInfo is required');
    if (typeof scLogRead !== 'function') throw new Error('TradeAutoManager: scLogRead is required');

    this.runTool = runTool;
    this.scLogInfo = scLogInfo;
    this.scLogRead = scLogRead;
    this.logger = typeof logger === 'function' ? logger : null;

    this.running = false;
    this.opts = null;
    this._timer = null;
    this._tickInFlight = false;

    this._lastSeq = 0;
    this._events = [];
    this._eventsMax = 2000;
    this._dedupeMax = 6000;
    this._stageMax = 6000;
    this._preimageMax = 2000;
    this._lockMaxAgeMs = 20 * 60 * 1000;
    this._doneMaxAgeMs = 40 * 60 * 1000;
    this._debugMax = 500;
    this._debugEvents = [];

    this._autoQuotedRfqSig = new Set();
    this._autoAcceptedQuoteSig = new Set();
    this._autoAcceptedTradeLock = new Map(); // trade_id -> locked_at_ms
    this._autoInvitedAcceptSig = new Set();
    this._autoJoinedInviteSig = new Set();
    this._stageDone = new Map(); // stage_key -> done_at_ms
    this._stageInFlight = new Set();
    this._stageRetryAfter = new Map();
    this._tradePreimage = new Map();

    this._stats = {
      ticks: 0,
      actions: 0,
      last_tick_at: null,
      last_error: null,
      started_at: null,
    };
  }

  _log(msg) {
    if (this.logger) {
      try {
        this.logger(msg);
      } catch (_e) {}
    }
  }

  _trace(type, details = {}) {
    try {
      const evt = {
        ts: Date.now(),
        type: String(type || 'trace'),
        ...(details && typeof details === 'object' ? details : {}),
      };
      this._debugEvents.push(evt);
      if (this._debugEvents.length > this._debugMax) {
        this._debugEvents.splice(0, this._debugEvents.length - this._debugMax);
      }
    } catch (_e) {}
  }

  status() {
    return {
      type: 'tradeauto_status',
      running: this.running,
      options: this.opts || null,
      stats: { ...this._stats },
      memory: {
        events: this._events.length,
        auto_quoted_rfq_sig: this._autoQuotedRfqSig.size,
        auto_accepted_quote_sig: this._autoAcceptedQuoteSig.size,
        auto_accepted_trade_lock: this._autoAcceptedTradeLock.size,
        auto_invited_accept_sig: this._autoInvitedAcceptSig.size,
        auto_joined_invite_sig: this._autoJoinedInviteSig.size,
        stage_done: this._stageDone.size,
        stage_in_flight: this._stageInFlight.size,
        stage_retry_after: this._stageRetryAfter.size,
        trade_preimage: this._tradePreimage.size,
        debug_events: this._debugEvents.length,
      },
      recent_events: this._debugEvents.slice(-Math.min(200, this._debugMax)),
    };
  }

  async start(opts = {}) {
    if (this.running) {
      return { ...this.status(), type: 'tradeauto_already_running' };
    }

    const channels = sanitizeChannels(opts.channels || []);
    if (channels.length < 1) throw new Error('tradeauto_start: channels must be a non-empty array');

    const intervalMs = clampInt(toIntOrNull(opts.interval_ms), { min: 250, max: 10000, fallback: 1000 });
    const maxEvents = clampInt(toIntOrNull(opts.max_events), { min: 200, max: 4000, fallback: 1500 });
    const maxTrades = clampInt(toIntOrNull(opts.max_trades), { min: 10, max: 500, fallback: 120 });
    const eventMaxAgeMs = clampInt(toIntOrNull(opts.event_max_age_ms), { min: 30_000, max: 60 * 60 * 1000, fallback: 10 * 60 * 1000 });
    const dedupeMax = clampInt(toIntOrNull(opts.dedupe_max), {
      min: 500,
      max: 50_000,
      fallback: Math.max(2_000, maxEvents * 3),
    });
    const stageMax = clampInt(toIntOrNull(opts.stage_max), {
      min: 500,
      max: 50_000,
      fallback: Math.max(2_000, maxTrades * 25),
    });
    const preimageMax = clampInt(toIntOrNull(opts.preimage_max), {
      min: 100,
      max: 20_000,
      fallback: Math.max(500, maxTrades * 8),
    });
    const lockMaxAgeMs = clampInt(toIntOrNull(opts.lock_max_age_ms), {
      min: 30_000,
      max: 24 * 60 * 60 * 1000,
      fallback: Math.max(eventMaxAgeMs * 2, 5 * 60 * 1000),
    });
    const doneMaxAgeMs = clampInt(toIntOrNull(opts.done_max_age_ms), {
      min: 60_000,
      max: 24 * 60 * 60 * 1000,
      fallback: Math.max(eventMaxAgeMs * 4, 20 * 60 * 1000),
    });
    const debugMax = clampInt(toIntOrNull(opts.debug_max_events), {
      min: 50,
      max: 10_000,
      fallback: 600,
    });
    const defaultSolRefundWindowSec = clampInt(toIntOrNull(opts.default_sol_refund_window_sec), {
      min: 3600,
      max: 7 * 24 * 3600,
      fallback: 72 * 3600,
    });
    const welcomeTtlSec = clampInt(toIntOrNull(opts.welcome_ttl_sec), { min: 30, max: 7 * 24 * 3600, fallback: 3600 });

    const lnLiquidityModeRaw = String(opts.ln_liquidity_mode || 'aggregate').trim().toLowerCase();
    const lnLiquidityMode = lnLiquidityModeRaw === 'single_channel' ? 'single_channel' : 'aggregate';
    const usdtMint = String(opts.usdt_mint || '').trim();

    this.opts = {
      channels,
      interval_ms: intervalMs,
      max_events: maxEvents,
      max_trades: maxTrades,
      event_max_age_ms: eventMaxAgeMs,
      dedupe_max: dedupeMax,
      stage_max: stageMax,
      preimage_max: preimageMax,
      lock_max_age_ms: lockMaxAgeMs,
      done_max_age_ms: doneMaxAgeMs,
      debug_max_events: debugMax,
      default_sol_refund_window_sec: defaultSolRefundWindowSec,
      welcome_ttl_sec: welcomeTtlSec,
      ln_liquidity_mode: lnLiquidityMode,
      usdt_mint: usdtMint || null,
      enable_quote_from_offers: opts.enable_quote_from_offers !== false,
      enable_accept_quotes: opts.enable_accept_quotes !== false,
      enable_invite_from_accepts: opts.enable_invite_from_accepts !== false,
      enable_join_invites: opts.enable_join_invites !== false,
      enable_settlement: opts.enable_settlement !== false,
      sol_cu_limit: toIntOrNull(opts.sol_cu_limit),
      sol_cu_price: toIntOrNull(opts.sol_cu_price),
    };

    this._lastSeq = 0;
    this._events = [];
    this._eventsMax = maxEvents;
    this._dedupeMax = dedupeMax;
    this._stageMax = stageMax;
    this._preimageMax = preimageMax;
    this._lockMaxAgeMs = lockMaxAgeMs;
    this._doneMaxAgeMs = doneMaxAgeMs;
    this._debugMax = debugMax;
    this._debugEvents = [];
    this._autoQuotedRfqSig.clear();
    this._autoAcceptedQuoteSig.clear();
    this._autoAcceptedTradeLock.clear();
    this._autoInvitedAcceptSig.clear();
    this._autoJoinedInviteSig.clear();
    this._stageDone.clear();
    this._stageInFlight.clear();
    this._stageRetryAfter.clear();
    this._tradePreimage.clear();

    this._stats = {
      ticks: 0,
      actions: 0,
      last_tick_at: Date.now(),
      last_error: null,
      started_at: Date.now(),
    };
    this._trace('tradeauto_start', {
      channels,
      interval_ms: intervalMs,
      max_events: maxEvents,
      max_trades: maxTrades,
      ln_liquidity_mode: lnLiquidityMode,
    });

    await this.runTool({ tool: 'intercomswap_sc_subscribe', args: { channels } });

    this.running = true;
    this._timer = setInterval(() => {
      void this._tick().catch((err) => {
        this._stats.last_error = err?.message || String(err);
      });
    }, intervalMs);
    await this._tick();

    return { type: 'tradeauto_started', ...this.status() };
  }

  async stop({ reason = 'stopped' } = {}) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.running = false;
    this._tickInFlight = false;
    this._stats.last_error = reason ? String(reason) : null;
    this._lastSeq = 0;
    this._events = [];
    this._autoQuotedRfqSig.clear();
    this._autoAcceptedQuoteSig.clear();
    this._autoAcceptedTradeLock.clear();
    this._autoInvitedAcceptSig.clear();
    this._autoJoinedInviteSig.clear();
    this._stageDone.clear();
    this._stageInFlight.clear();
    this._stageRetryAfter.clear();
    this._tradePreimage.clear();
    this._trace('tradeauto_stop', { reason: String(reason || 'stopped') });
    return { type: 'tradeauto_stopped', reason: String(reason || 'stopped'), ...this.status() };
  }

  _canRunStage(stageKey) {
    if (!stageKey) return false;
    if (this._stageDone.has(stageKey)) return false;
    if (this._stageInFlight.has(stageKey)) return false;
    const retryAfter = this._stageRetryAfter.get(stageKey) || 0;
    return Date.now() >= retryAfter;
  }

  _markStageInFlight(stageKey) {
    if (!stageKey) return;
    this._stageInFlight.add(stageKey);
  }

  _markStageSuccess(stageKey) {
    if (!stageKey) return;
    this._stageInFlight.delete(stageKey);
    this._stageRetryAfter.delete(stageKey);
    this._stageDone.set(stageKey, Date.now());
    this._trace('stage_ok', { stage: String(stageKey) });
  }

  _markStageRetry(stageKey, cooldownMs) {
    if (!stageKey) return;
    this._stageInFlight.delete(stageKey);
    this._stageRetryAfter.set(stageKey, Date.now() + Math.max(1000, Math.trunc(cooldownMs || 1000)));
    this._trace('stage_retry', { stage: String(stageKey), cooldown_ms: Math.max(1000, Math.trunc(cooldownMs || 1000)) });
  }

  _eventRetryKey(flow, sig) {
    return `evt:${String(flow || '')}:${String(sig || '')}`;
  }

  _canRunEvent(flow, sig) {
    if (!sig) return false;
    const key = this._eventRetryKey(flow, sig);
    const retryAfter = this._stageRetryAfter.get(key) || 0;
    return Date.now() >= retryAfter;
  }

  _markEventRetry(flow, sig, cooldownMs = 5000) {
    if (!sig) return;
    const key = this._eventRetryKey(flow, sig);
    this._stageRetryAfter.set(key, Date.now() + Math.max(1000, Math.trunc(cooldownMs || 1000)));
  }

  _clearEventRetry(flow, sig) {
    if (!sig) return;
    this._stageRetryAfter.delete(this._eventRetryKey(flow, sig));
  }

  _pruneTradeCachesById(tradeId) {
    if (!tradeId) return;
    this._autoAcceptedTradeLock.delete(tradeId);
    this._tradePreimage.delete(tradeId);
    const prefix = `${tradeId}:`;
    for (const key of Array.from(this._stageDone.keys())) {
      if (String(key).startsWith(prefix)) this._stageDone.delete(key);
    }
    for (const key of Array.from(this._stageInFlight.values())) {
      if (String(key).startsWith(prefix)) this._stageInFlight.delete(key);
    }
    for (const key of Array.from(this._stageRetryAfter.keys())) {
      if (String(key).startsWith(prefix)) this._stageRetryAfter.delete(key);
    }
  }

  _pruneCaches({ terminalTradeIds = null } = {}) {
    if (terminalTradeIds && typeof terminalTradeIds[Symbol.iterator] === 'function') {
      for (const tradeId of terminalTradeIds) this._pruneTradeCachesById(String(tradeId || '').trim());
    }

    const now = Date.now();
    for (const [tradeId, lockedAt] of Array.from(this._autoAcceptedTradeLock.entries())) {
      if (!tradeId) {
        this._autoAcceptedTradeLock.delete(tradeId);
        continue;
      }
      if (!Number.isFinite(lockedAt) || now - Number(lockedAt) > this._lockMaxAgeMs) {
        this._autoAcceptedTradeLock.delete(tradeId);
      }
    }

    for (const [stageKey, doneAt] of Array.from(this._stageDone.entries())) {
      if (!Number.isFinite(doneAt)) {
        this._stageDone.delete(stageKey);
        continue;
      }
      if (now - Number(doneAt) > this._doneMaxAgeMs) this._stageDone.delete(stageKey);
    }

    for (const [stageKey, retryAfter] of Array.from(this._stageRetryAfter.entries())) {
      if (!Number.isFinite(retryAfter)) {
        this._stageRetryAfter.delete(stageKey);
        continue;
      }
      if (now - Number(retryAfter) > this._doneMaxAgeMs) this._stageRetryAfter.delete(stageKey);
    }

    pruneSetByLimit(this._autoQuotedRfqSig, this._dedupeMax);
    pruneSetByLimit(this._autoAcceptedQuoteSig, this._dedupeMax);
    pruneMapByLimit(this._autoAcceptedTradeLock, Math.max(this.opts?.max_trades || 120, this._preimageMax));
    pruneSetByLimit(this._autoInvitedAcceptSig, this._dedupeMax);
    pruneSetByLimit(this._autoJoinedInviteSig, this._dedupeMax);
    pruneMapByLimit(this._stageDone, this._stageMax);
    pruneSetByLimit(this._stageInFlight, this._stageMax);
    pruneMapByLimit(this._stageRetryAfter, this._stageMax);
    pruneMapByLimit(this._tradePreimage, this._preimageMax);
  }

  _appendEvents(events) {
    if (!Array.isArray(events) || events.length < 1) return;
    for (const e of events) this._events.push(e);
    if (this._events.length > this._eventsMax) {
      this._events.splice(0, this._events.length - this._eventsMax);
    }
  }

  _buildContexts({ events, localPeer }) {
    const myRfqTradeIds = new Set();
    const myQuoteById = new Map();
    const myOfferEvents = [];
    const quoteEvents = [];
    const acceptEvents = [];
    const inviteEvents = [];
    const terminalTradeIds = new Set();

    const swapNegotiationByTrade = new Map();
    const swapTradeContextsByTrade = new Map();

    for (const e of events) {
      const kind = envelopeKind(e);
      if (!kind.startsWith('swap.')) continue;
      const msg = e?.message && typeof e.message === 'object' ? e.message : null;
      if (!msg) continue;
      const tradeId = envelopeTradeId(e);
      const signer = envelopeSigner(e);
      const local = isLocalEvent(e) || (localPeer && signer === localPeer);

      if (kind === 'swap.rfq' && local && tradeId) myRfqTradeIds.add(tradeId);

      if (kind === 'swap.quote') {
        const quoteId = (() => {
          try {
            const unsigned = stripSignature(msg);
            const id = hashUnsignedEnvelope(unsigned);
            return String(id || '').trim().toLowerCase();
          } catch (_e) {
            const s = String(msg?.body?.rfq_id || '').trim();
            const t = String(msg?.trade_id || '').trim();
            return `${t}:${s}:${eventTs(e)}`;
          }
        })();
        if (local) myQuoteById.set(quoteId, { event: e, envelope: msg, channel: String(e?.channel || '').trim() });
        else quoteEvents.push(e);
      }

      if (kind === 'swap.svc_announce' && local) myOfferEvents.push(e);
      if (kind === 'swap.quote_accept' && !local) acceptEvents.push(e);
      if (kind === 'swap.swap_invite' && !local) inviteEvents.push(e);

      if (tradeId) {
        let neg = swapNegotiationByTrade.get(tradeId);
        if (!neg) {
          neg = { trade_id: tradeId, rfq: null, quote: null, quote_accept: null, swap_invite: null, swap_channel: '' };
          swapNegotiationByTrade.set(tradeId, neg);
        }
        if (kind === 'swap.rfq' && !neg.rfq) neg.rfq = msg;
        else if (kind === 'swap.quote' && !neg.quote) neg.quote = msg;
        else if (kind === 'swap.quote_accept' && !neg.quote_accept) neg.quote_accept = msg;
        else if (kind === 'swap.swap_invite') {
          if (!neg.swap_invite) neg.swap_invite = msg;
          const ch = String(msg?.body?.swap_channel || '').trim();
          if (ch) neg.swap_channel = ch;
        }
      }

      const ch = String(e?.channel || '').trim();
      if (tradeId && ch.startsWith('swap:')) {
        let ctx = swapTradeContextsByTrade.get(tradeId);
        if (!ctx) {
          ctx = {
            trade_id: tradeId,
            channel: ch,
            last_ts: 0,
            terms: null,
            accept: null,
            invoice: null,
            escrow: null,
            ln_paid: null,
            claimed: null,
            refunded: null,
            canceled: null,
          };
          swapTradeContextsByTrade.set(tradeId, ctx);
        }
        const ts = eventTs(e);
        if (ts > Number(ctx.last_ts || 0)) ctx.last_ts = ts;
        if (ch) ctx.channel = ch;
        if (kind === 'swap.terms') ctx.terms = msg;
        else if (kind === 'swap.accept') ctx.accept = msg;
        else if (kind === 'swap.ln_invoice') ctx.invoice = msg;
        else if (kind === 'swap.sol_escrow_created') ctx.escrow = msg;
        else if (kind === 'swap.ln_paid') ctx.ln_paid = msg;
        else if (kind === 'swap.sol_claimed') {
          ctx.claimed = msg;
          terminalTradeIds.add(tradeId);
        } else if (kind === 'swap.sol_refunded') {
          ctx.refunded = msg;
          terminalTradeIds.add(tradeId);
        } else if (kind === 'swap.cancel') {
          ctx.canceled = msg;
          terminalTradeIds.add(tradeId);
        }
      }
    }

    const swapTradeContexts = Array.from(swapTradeContextsByTrade.values()).sort((a, b) => Number(b.last_ts || 0) - Number(a.last_ts || 0));

    return {
      myRfqTradeIds,
      myQuoteById,
      myOfferEvents,
      quoteEvents,
      acceptEvents,
      inviteEvents,
      swapNegotiationByTrade,
      swapTradeContexts,
      terminalTradeIds,
    };
  }

  async _tick() {
    if (!this.running) return;
    if (this._tickInFlight) return;
    this._tickInFlight = true;
    try {
      const logInfo = this.scLogInfo() || {};
      const latestSeq = Number.isFinite(logInfo.latest_seq) ? Math.max(0, Math.trunc(logInfo.latest_seq)) : 0;
      const sinceSeq = this._lastSeq > 0 ? this._lastSeq : Math.max(0, latestSeq - this.opts.max_events);
      const read = this.scLogRead({ sinceSeq, limit: this.opts.max_events }) || {};
      const events = Array.isArray(read.events) ? read.events : [];
      if (events.length > 0) {
        this._appendEvents(events);
      }
      this._lastSeq = Number.isFinite(read.latest_seq) ? Math.max(this._lastSeq, Math.trunc(read.latest_seq)) : this._lastSeq;

      const localPeer = String((await this.runTool({ tool: 'intercomswap_sc_info', args: {} }))?.peer || '').trim().toLowerCase();
      const localSolSigner = String((await this.runTool({ tool: 'intercomswap_sol_signer_pubkey', args: {} }))?.pubkey || '').trim();

      const activeEvents = this._events.filter((e) => !isEventStale(e, this.opts.event_max_age_ms));
      const ctx = this._buildContexts({ events: activeEvents, localPeer });

      for (const tid of Array.from(this._autoAcceptedTradeLock.keys())) {
        if (ctx.terminalTradeIds.has(tid)) this._autoAcceptedTradeLock.delete(tid);
      }
      this._pruneCaches({ terminalTradeIds: ctx.terminalTradeIds });

      let actionsLeft = 12;

      if (this.opts.enable_quote_from_offers && actionsLeft > 0) {
        const rfqQueue = [...activeEvents]
          .filter((e) => envelopeKind(e) === 'swap.rfq')
          .reverse();
        for (const rfqEvt of rfqQueue) {
          if (actionsLeft <= 0) break;
          if (isLocalEvent(rfqEvt)) continue;
          const sig = envelopeSig(rfqEvt);
          if (!sig || this._autoQuotedRfqSig.has(sig)) continue;
          if (!this._canRunEvent('quote_from_offer', sig)) continue;
          const match = matchOfferForRfq({ rfqEvt, myOfferEvents: ctx.myOfferEvents });
          if (!match) continue;
          try {
            const ch = String(rfqEvt?.channel || '').trim();
            if (!ch) continue;
            await this.runTool({
              tool: 'intercomswap_quote_post_from_rfq',
              args: {
                channel: ch,
                rfq_envelope: rfqEvt.message,
                trade_fee_collector: localSolSigner,
                sol_refund_window_sec: match.solRefundWindowSec,
                valid_for_sec: 180,
              },
            });
            this._trace('auto_quote_ok', { trade_id: envelopeTradeId(rfqEvt), channel: ch, sig: sig.slice(0, 16) });
            this._autoQuotedRfqSig.add(sig);
            this._clearEventRetry('quote_from_offer', sig);
            this._pruneCaches();
            actionsLeft -= 1;
            this._stats.actions += 1;
          } catch (err) {
            this._trace('auto_quote_fail', {
              trade_id: envelopeTradeId(rfqEvt),
              channel: String(rfqEvt?.channel || '').trim(),
              sig: sig.slice(0, 16),
              error: err?.message || String(err),
            });
            this._markEventRetry('quote_from_offer', sig, 5000);
            this._log(`[tradeauto] auto-quote failed: ${err?.message || String(err)}`);
          }
        }
      }

      if (this.opts.enable_accept_quotes && actionsLeft > 0) {
        const quoteQueue = [...ctx.quoteEvents].reverse();
        for (const quoteEvt of quoteQueue) {
          if (actionsLeft <= 0) break;
          if (isEventStale(quoteEvt, this.opts.event_max_age_ms)) continue;
          const sig = envelopeSig(quoteEvt);
          if (!sig || this._autoAcceptedQuoteSig.has(sig)) continue;
          if (!this._canRunEvent('accept_quote', sig)) continue;
          const tradeId = envelopeTradeId(quoteEvt);
          if (!tradeId || !ctx.myRfqTradeIds.has(tradeId)) continue;
          if (ctx.terminalTradeIds.has(tradeId)) continue;
          if (this._autoAcceptedTradeLock.has(tradeId)) continue;
          try {
            await this.runTool({
              tool: 'intercomswap_quote_accept',
              args: {
                channel: String(quoteEvt?.channel || '').trim(),
                quote_envelope: quoteEvt.message,
                ln_liquidity_mode: this.opts.ln_liquidity_mode,
              },
            });
            this._trace('auto_accept_ok', {
              trade_id: tradeId,
              channel: String(quoteEvt?.channel || '').trim(),
              quote_sig: sig.slice(0, 16),
            });
            this._autoAcceptedQuoteSig.add(sig);
            this._clearEventRetry('accept_quote', sig);
            this._autoAcceptedTradeLock.set(tradeId, Date.now());
            this._pruneCaches();
            actionsLeft -= 1;
            this._stats.actions += 1;
          } catch (err) {
            this._trace('auto_accept_fail', {
              trade_id: tradeId,
              channel: String(quoteEvt?.channel || '').trim(),
              quote_sig: sig.slice(0, 16),
              error: err?.message || String(err),
            });
            this._markEventRetry('accept_quote', sig, 5000);
            this._log(`[tradeauto] auto-accept failed: ${err?.message || String(err)}`);
          }
        }
      }

      if (this.opts.enable_invite_from_accepts && actionsLeft > 0) {
        const accepts = [...ctx.acceptEvents].reverse();
        for (const e of accepts) {
          if (actionsLeft <= 0) break;
          if (isEventStale(e, this.opts.event_max_age_ms)) continue;
          const sig = envelopeSig(e);
          if (!sig || this._autoInvitedAcceptSig.has(sig)) continue;
          if (!this._canRunEvent('invite_from_accept', sig)) continue;
          const quoteId = String(e?.message?.body?.quote_id || '').trim().toLowerCase();
          const myQuote = ctx.myQuoteById.get(quoteId);
          if (!myQuote) continue;
          try {
            const tradeId = envelopeTradeId(e);
            const out = await this.runTool({
              tool: 'intercomswap_swap_invite_from_accept',
              args: {
                channel: String(e?.channel || myQuote.channel || '').trim(),
                accept_envelope: e.message,
                quote_envelope: myQuote.envelope,
                welcome_text: tradeId ? `Welcome to ${tradeId}` : 'Welcome to swap',
                ttl_sec: this.opts.welcome_ttl_sec,
              },
            });
            this._trace('auto_invite_ok', {
              trade_id: tradeId,
              channel: String(e?.channel || myQuote.channel || '').trim(),
              accept_sig: sig.slice(0, 16),
            });
            this._autoInvitedAcceptSig.add(sig);
            this._clearEventRetry('invite_from_accept', sig);
            this._pruneCaches();
            const swapCh = String(out?.swap_channel || '').trim();
            if (swapCh) await this.runTool({ tool: 'intercomswap_sc_subscribe', args: { channels: [swapCh] } });
            actionsLeft -= 1;
            this._stats.actions += 1;
          } catch (err) {
            this._trace('auto_invite_fail', {
              trade_id: envelopeTradeId(e),
              channel: String(e?.channel || myQuote.channel || '').trim(),
              accept_sig: sig.slice(0, 16),
              error: err?.message || String(err),
            });
            this._markEventRetry('invite_from_accept', sig, 5000);
            this._log(`[tradeauto] auto-invite failed: ${err?.message || String(err)}`);
          }
        }
      }

      if (this.opts.enable_join_invites && actionsLeft > 0) {
        const invites = [...ctx.inviteEvents].reverse();
        for (const e of invites) {
          if (actionsLeft <= 0) break;
          if (isEventStale(e, this.opts.event_max_age_ms)) continue;
          const sig = envelopeSig(e);
          if (!sig || this._autoJoinedInviteSig.has(sig)) continue;
          if (!this._canRunEvent('join_invite', sig)) continue;
          const tradeId = envelopeTradeId(e);
          if (tradeId && ctx.terminalTradeIds.has(tradeId)) continue;
          const invitee = String(e?.message?.body?.invite?.payload?.inviteePubKey || '').trim().toLowerCase();
          if (invitee && localPeer && invitee !== localPeer) continue;
          try {
            const out = await this.runTool({
              tool: 'intercomswap_join_from_swap_invite',
              args: { swap_invite_envelope: e.message },
            });
            this._trace('auto_join_ok', {
              trade_id: tradeId,
              channel: String(e?.channel || '').trim(),
              invite_sig: sig.slice(0, 16),
            });
            this._autoJoinedInviteSig.add(sig);
            this._clearEventRetry('join_invite', sig);
            this._pruneCaches();
            const swapCh = String(out?.swap_channel || e?.message?.body?.swap_channel || '').trim();
            if (swapCh) await this.runTool({ tool: 'intercomswap_sc_subscribe', args: { channels: [swapCh] } });
            actionsLeft -= 1;
            this._stats.actions += 1;
          } catch (err) {
            this._trace('auto_join_fail', {
              trade_id: tradeId,
              channel: String(e?.channel || '').trim(),
              invite_sig: sig.slice(0, 16),
              error: err?.message || String(err),
            });
            this._markEventRetry('join_invite', sig, 5000);
            this._log(`[tradeauto] auto-join failed: ${err?.message || String(err)}`);
          }
        }
      }

      if (this.opts.enable_settlement && actionsLeft > 0) {
        for (const tradeCtx of ctx.swapTradeContexts.slice(0, this.opts.max_trades)) {
          if (actionsLeft <= 0) break;
          const tradeId = String(tradeCtx?.trade_id || '').trim();
          if (!tradeId) continue;
          if (tradeCtx.claimed || tradeCtx.refunded || tradeCtx.canceled) continue;

          const neg = ctx.swapNegotiationByTrade.get(tradeId) || {};
          const rfqEnv = isObject(neg?.rfq) ? neg.rfq : null;
          const quoteEnv = isObject(neg?.quote) ? neg.quote : null;
          const quoteAcceptEnv = isObject(neg?.quote_accept) ? neg.quote_accept : null;

          const termsEnv = isObject(tradeCtx?.terms) ? tradeCtx.terms : null;
          const acceptEnv = isObject(tradeCtx?.accept) ? tradeCtx.accept : null;
          const invoiceEnv = isObject(tradeCtx?.invoice) ? tradeCtx.invoice : null;
          const escrowEnv = isObject(tradeCtx?.escrow) ? tradeCtx.escrow : null;
          const lnPaidEnv = isObject(tradeCtx?.ln_paid) ? tradeCtx.ln_paid : null;

          const makerSigner = String(termsEnv?.signer || quoteEnv?.signer || '').trim().toLowerCase();
          const takerSigner = String(acceptEnv?.signer || quoteAcceptEnv?.signer || rfqEnv?.signer || '').trim().toLowerCase();
          const iAmMaker = Boolean(localPeer && makerSigner && makerSigner === localPeer);
          const iAmTaker = Boolean((localPeer && takerSigner && takerSigner === localPeer) || ctx.myRfqTradeIds.has(tradeId));
          if (!iAmMaker && !iAmTaker) continue;

          const swapChannel = String(tradeCtx?.channel || neg?.swap_channel || `swap:${tradeId}`).trim();
          if (!swapChannel.startsWith('swap:')) continue;

          const termsBody = isObject(termsEnv?.body) ? termsEnv.body : {};
          const termsLnPayerPeer = String(termsBody?.ln_payer_peer || '').trim().toLowerCase();
          const termsSolRecipient = String(termsBody?.sol_recipient || '').trim();

          const termsBoundToLocalIdentity = (() => {
            if (!termsEnv) return true;
            if (!localPeer) return false;
            if (!/^[0-9a-f]{64}$/i.test(termsLnPayerPeer)) return false;
            return termsLnPayerPeer === localPeer;
          })();
          const termsBoundToLocalSolRecipient = (() => {
            if (!termsEnv) return true;
            if (!localSolSigner) return false;
            return Boolean(termsSolRecipient && termsSolRecipient === localSolSigner);
          })();

          if (iAmMaker && !termsEnv && quoteEnv && rfqEnv && quoteAcceptEnv) {
            const stageKey = `${tradeId}:terms_post`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                const quoteBody = isObject(quoteEnv?.body) ? quoteEnv.body : {};
                const rfqBody = isObject(rfqEnv?.body) ? rfqEnv.body : {};
                const btcSats = toIntOrNull(quoteBody?.btc_sats ?? rfqBody?.btc_sats);
                const usdtAmount = String(quoteBody?.usdt_amount ?? rfqBody?.usdt_amount ?? '').trim();
                const solRecipient = String(rfqBody?.sol_recipient || '').trim();
                const solRefund = localSolSigner;
                const tradeFeeCollector = String(quoteBody?.trade_fee_collector || '').trim();
                const lnPayerPeer = String(quoteAcceptEnv?.signer || rfqEnv?.signer || '').trim().toLowerCase();
                const solMint = String(this.opts.usdt_mint || rfqBody?.sol_mint || quoteBody?.sol_mint || '').trim();
                if (btcSats === null || btcSats < 1) throw new Error('terms_post: missing btc_sats');
                if (!/^[0-9]+$/.test(usdtAmount)) throw new Error('terms_post: missing usdt_amount');
                if (!solMint) throw new Error('terms_post: missing usdt_mint');
                if (!solRecipient) throw new Error('terms_post: missing sol_recipient');
                if (!solRefund) throw new Error('terms_post: missing sol_refund');
                if (!tradeFeeCollector) throw new Error('terms_post: missing trade_fee_collector');
                if (!lnPayerPeer) throw new Error('terms_post: missing ln_payer_peer');
                const quoteRefundWindowSec = clampInt(toIntOrNull(quoteBody?.sol_refund_window_sec), {
                  min: 3600,
                  max: 7 * 24 * 3600,
                  fallback: this.opts.default_sol_refund_window_sec,
                });
                const refundAfterUnix = Math.floor(Date.now() / 1000) + quoteRefundWindowSec;
                const termsValidUntilUnix = toIntOrNull(quoteBody?.valid_until_unix);
                await this.runTool({
                  tool: 'intercomswap_terms_post',
                  args: {
                    channel: swapChannel,
                    trade_id: tradeId,
                    btc_sats: btcSats,
                    usdt_amount: usdtAmount,
                    sol_mint: solMint,
                    sol_recipient: solRecipient,
                    sol_refund: solRefund,
                    sol_refund_after_unix: refundAfterUnix,
                    ln_receiver_peer: localPeer,
                    ln_payer_peer: lnPayerPeer,
                    trade_fee_collector: tradeFeeCollector,
                    ...(termsValidUntilUnix && termsValidUntilUnix > 0 ? { terms_valid_until_unix: termsValidUntilUnix } : {}),
                  },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmTaker && termsEnv && !acceptEnv) {
            const stageKey = `${tradeId}:terms_accept`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                if (!termsBoundToLocalIdentity) throw new Error('terms_accept: terms.ln_payer_peer mismatch');
                if (!termsBoundToLocalSolRecipient) throw new Error('terms_accept: terms.sol_recipient mismatch');
                await this.runTool({
                  tool: 'intercomswap_terms_accept_from_terms',
                  args: { channel: swapChannel, terms_envelope: termsEnv },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmMaker && termsEnv && acceptEnv && !invoiceEnv) {
            const stageKey = `${tradeId}:ln_invoice`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                const btcSats = toIntOrNull(termsBody?.btc_sats);
                if (btcSats === null || btcSats < 1) throw new Error('ln_invoice: missing btc_sats');
                await this.runTool({
                  tool: 'intercomswap_swap_ln_invoice_create_and_post',
                  args: {
                    channel: swapChannel,
                    trade_id: tradeId,
                    btc_sats: btcSats,
                    label: `swap-${tradeId}-${Date.now()}`.slice(0, 120),
                    description: `intercomswap ${tradeId}`.slice(0, 500),
                  },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmMaker && termsEnv && invoiceEnv && !escrowEnv) {
            const stageKey = `${tradeId}:sol_escrow`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                const invBody = isObject(invoiceEnv?.body) ? invoiceEnv.body : {};
                const paymentHashHex = String(invBody?.payment_hash_hex || '').trim().toLowerCase();
                const mint = String(termsBody?.sol_mint || this.opts.usdt_mint || '').trim();
                const amount = String(termsBody?.usdt_amount || '').trim();
                const recipient = String(termsBody?.sol_recipient || '').trim();
                const refund = String(termsBody?.sol_refund || '').trim();
                const refundAfterUnix = toIntOrNull(termsBody?.sol_refund_after_unix);
                const tradeFeeCollector = String(termsBody?.trade_fee_collector || '').trim();
                if (!/^[0-9a-f]{64}$/i.test(paymentHashHex)) throw new Error('sol_escrow: missing payment_hash_hex');
                if (!mint) throw new Error('sol_escrow: missing mint');
                if (!/^[0-9]+$/.test(amount)) throw new Error('sol_escrow: missing amount');
                if (!recipient) throw new Error('sol_escrow: missing recipient');
                if (!refund) throw new Error('sol_escrow: missing refund');
                if (refundAfterUnix === null || refundAfterUnix < 1) throw new Error('sol_escrow: missing refund_after_unix');
                if (!tradeFeeCollector) throw new Error('sol_escrow: missing trade_fee_collector');

                await this.runTool({
                  tool: 'intercomswap_swap_sol_escrow_init_and_post',
                  args: {
                    channel: swapChannel,
                    trade_id: tradeId,
                    payment_hash_hex: paymentHashHex,
                    mint,
                    amount,
                    recipient,
                    refund,
                    refund_after_unix: refundAfterUnix,
                    trade_fee_collector: tradeFeeCollector,
                    ...(this.opts.sol_cu_limit && this.opts.sol_cu_limit > 0 ? { cu_limit: this.opts.sol_cu_limit } : {}),
                    ...(this.opts.sol_cu_price && this.opts.sol_cu_price > 0 ? { cu_price: this.opts.sol_cu_price } : {}),
                  },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmTaker && termsEnv && invoiceEnv && escrowEnv && !lnPaidEnv) {
            const stageKey = `${tradeId}:ln_pay`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                if (!termsBoundToLocalIdentity) throw new Error('ln_pay: terms.ln_payer_peer mismatch');
                if (!termsBoundToLocalSolRecipient) throw new Error('ln_pay: terms.sol_recipient mismatch');
                const out = await this.runTool({
                  tool: 'intercomswap_swap_ln_pay_and_post_verified',
                  args: {
                    channel: swapChannel,
                    terms_envelope: termsEnv,
                    invoice_envelope: invoiceEnv,
                    escrow_envelope: escrowEnv,
                  },
                });
                const preimageHex = String(out?.preimage_hex || '').trim().toLowerCase();
                if (/^[0-9a-f]{64}$/i.test(preimageHex)) this._tradePreimage.set(tradeId, preimageHex);
                this._pruneCaches();
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmTaker && termsEnv && lnPaidEnv && !tradeCtx?.claimed) {
            const stageKey = `${tradeId}:sol_claim`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                if (!termsBoundToLocalSolRecipient) throw new Error('sol_claim: terms.sol_recipient mismatch');
                const mint = String(termsBody?.sol_mint || this.opts.usdt_mint || '').trim();
                if (!mint) throw new Error('sol_claim: missing mint');
                let preimageHex = String(this._tradePreimage.get(tradeId) || '').trim().toLowerCase();
                if (!/^[0-9a-f]{64}$/i.test(preimageHex)) {
                  const rec = await this.runTool({
                    tool: 'intercomswap_receipts_show',
                    args: { trade_id: tradeId },
                  });
                  preimageHex = String(rec?.ln_preimage_hex || '').trim().toLowerCase();
                  if (/^[0-9a-f]{64}$/i.test(preimageHex)) this._tradePreimage.set(tradeId, preimageHex);
                  this._pruneCaches();
                }
                if (!/^[0-9a-f]{64}$/i.test(preimageHex)) throw new Error('sol_claim: missing LN preimage');
                await this.runTool({
                  tool: 'intercomswap_swap_sol_claim_and_post',
                  args: { channel: swapChannel, trade_id: tradeId, preimage_hex: preimageHex, mint },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 15_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
          }
        }
      }

      this._stats.ticks += 1;
      this._stats.last_tick_at = Date.now();
      this._stats.last_error = null;
    } catch (err) {
      this._stats.last_error = err?.message || String(err);
      this._log(`[tradeauto] tick failed: ${this._stats.last_error}`);
      throw err;
    } finally {
      this._tickInFlight = false;
    }
  }
}
