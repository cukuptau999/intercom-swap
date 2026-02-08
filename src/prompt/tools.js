function tool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters,
    },
  };
}

const emptyParams = { type: 'object', additionalProperties: false, properties: {} };

const channelParam = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Sidechannel name (e.g. 0000intercomswapbtcusdt or swap:<id>)',
};

const base64Param = {
  type: 'string',
  minLength: 1,
  maxLength: 16384,
  description: 'Base64-encoded JSON payload',
};

const hex32Param = {
  type: 'string',
  minLength: 64,
  maxLength: 64,
  pattern: '^[0-9a-fA-F]{64}$',
};

const base58Param = {
  type: 'string',
  minLength: 32,
  maxLength: 64,
  pattern: '^[1-9A-HJ-NP-Za-km-z]+$',
};

const unixSecParam = { type: 'integer', minimum: 1, description: 'Unix seconds timestamp' };

const atomicAmountParam = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[0-9]+$',
  description: 'Decimal string amount in smallest units (atomic)',
};

const satsParam = { type: 'integer', minimum: 1, maximum: 21_000_000 * 100_000_000, description: 'Satoshis' };

// NOTE: This is a first, safe “tool surface” for prompting.
// The executor (Phase 5B) must validate and *must not* allow arbitrary file paths or shell execution.
export const INTERCOMSWAP_TOOLS = [
  // SC-Bridge safe RPCs (no CLI mirroring).
  tool('intercomswap_sc_info', 'Get peer info via SC-Bridge (safe fields only).', emptyParams),
  tool('intercomswap_sc_stats', 'Get SC-Bridge stats.', emptyParams),
  tool('intercomswap_sc_price_get', 'Get latest price snapshot from local price feature/oracle.', emptyParams),
  tool('intercomswap_sc_subscribe', 'Subscribe this prompt session to sidechannel message events for specific channels.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channels: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: channelParam,
        description: 'Channels to receive events for.',
      },
    },
    required: ['channels'],
  }),
  tool(
    'intercomswap_sc_wait_envelope',
    'Wait for the next signed swap envelope seen on subscribed sidechannels. Returns a handle to the full envelope.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channels: {
          type: 'array',
          minItems: 0,
          maxItems: 50,
          items: channelParam,
          description: 'Optional channel allowlist. If omitted/empty, any subscribed channel is accepted.',
        },
        kinds: {
          type: 'array',
          minItems: 0,
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 64 },
          description: 'Optional swap envelope kind allowlist (e.g. swap.rfq, swap.quote, swap.swap_invite).',
        },
        timeout_ms: { type: 'integer', minimum: 10, maximum: 120000, description: 'Long-poll timeout in ms.' },
      },
      required: [],
    }
  ),
  tool('intercomswap_sc_join', 'Join a sidechannel (invite/welcome optional).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      invite_b64: { ...base64Param, description: 'Optional invite (base64 JSON).' },
      welcome_b64: { ...base64Param, description: 'Optional welcome (base64 JSON).' },
    },
    required: ['channel'],
  }),
  tool('intercomswap_sc_leave', 'Leave a sidechannel locally (channel hygiene).', {
    type: 'object',
    additionalProperties: false,
    properties: { channel: channelParam },
    required: ['channel'],
  }),
  tool('intercomswap_sc_open', 'Request/open a sidechannel via an entry channel (invite/welcome optional).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      via: { ...channelParam, description: 'Entry/rendezvous channel to send the open request through.' },
      invite_b64: { ...base64Param, description: 'Optional invite (base64 JSON).' },
      welcome_b64: { ...base64Param, description: 'Optional welcome (base64 JSON).' },
    },
    required: ['channel', 'via'],
  }),
  tool('intercomswap_sc_send_text', 'Send a plain text message to a channel.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      text: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    required: ['channel', 'text'],
  }),
  tool('intercomswap_sc_send_json', 'Send a JSON message to a channel (structured payload).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      json: { type: 'object' },
    },
    required: ['channel', 'json'],
  }),

  // RFQ / swap envelope helpers (Phase 5B executor will translate to swapctl+sign safely).
  tool('intercomswap_rfq_post', 'Post a signed RFQ envelope into an RFQ rendezvous channel.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      btc_sats: satsParam,
      usdt_amount: atomicAmountParam,
      valid_until_unix: { ...unixSecParam, description: 'Optional expiry for the RFQ (unix seconds).' },
    },
    required: ['channel', 'trade_id', 'btc_sats', 'usdt_amount'],
  }),
  tool(
    'intercomswap_quote_post',
    'Post a signed QUOTE envelope into an RFQ channel (references an RFQ id). Provide either valid_until_unix or valid_for_sec.',
    {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      rfq_id: hex32Param,
      btc_sats: satsParam,
      usdt_amount: atomicAmountParam,
      valid_until_unix: unixSecParam,
      valid_for_sec: { type: 'integer', minimum: 10, maximum: 60 * 60 * 24 * 7 },
    },
    required: ['channel', 'trade_id', 'rfq_id', 'btc_sats', 'usdt_amount'],
  }
  ),
  tool(
    'intercomswap_quote_post_from_rfq',
    'Maker: post a signed QUOTE that matches an RFQ envelope (no manual rfq_id/btc_sats/usdt_amount required). Provide either valid_until_unix or valid_for_sec.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        rfq_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed RFQ envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to an RFQ envelope.' },
          ],
        },
        valid_until_unix: unixSecParam,
        valid_for_sec: { type: 'integer', minimum: 10, maximum: 60 * 60 * 24 * 7 },
      },
      required: ['channel', 'rfq_envelope'],
    }
  ),
  tool('intercomswap_quote_accept', 'Post a signed QUOTE_ACCEPT envelope into the RFQ channel (accept a quote).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      quote_envelope: {
        anyOf: [
          { type: 'object', description: 'Full signed quote envelope received from the network.' },
          { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a quote envelope.' },
        ],
      },
    },
    required: ['channel', 'quote_envelope'],
  }),
  tool(
    'intercomswap_swap_invite_from_accept',
    'Maker: generate welcome+invite and post SWAP_INVITE into the RFQ channel, based on an accepted quote.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        accept_envelope: {
          anyOf: [
            { type: 'object', description: 'Full signed QUOTE_ACCEPT envelope received from the network.' },
            { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to an accept envelope.' },
          ],
        },
        swap_channel: { ...channelParam, description: 'Optional explicit swap:<id> channel name. If omitted, derived.' },
        welcome_text: { type: 'string', minLength: 1, maxLength: 500 },
        ttl_sec: { type: 'integer', minimum: 30, maximum: 60 * 60 * 24 * 7 },
      },
      required: ['channel', 'accept_envelope', 'welcome_text'],
    }
  ),
  tool('intercomswap_join_from_swap_invite', 'Taker: join swap:<id> channel using SWAP_INVITE envelope.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      swap_invite_envelope: {
        anyOf: [
          { type: 'object', description: 'Full signed SWAP_INVITE envelope received from maker.' },
          { type: 'string', pattern: '^secret:[0-9a-fA-F-]{10,}$', description: 'Secret handle to a swap invite envelope.' },
        ],
      },
    },
    required: ['swap_invite_envelope'],
  }),

  tool('intercomswap_terms_post', 'Maker: post signed TERMS envelope inside swap:<id>.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      btc_sats: satsParam,
      usdt_amount: atomicAmountParam,
      sol_mint: base58Param,
      sol_recipient: base58Param,
      sol_refund: base58Param,
      sol_refund_after_unix: unixSecParam,
      ln_receiver_peer: hex32Param,
      ln_payer_peer: hex32Param,
      platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
      trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
      trade_fee_collector: base58Param,
      platform_fee_collector: { ...base58Param, description: 'Optional override, else use program config fee collector.' },
      terms_valid_until_unix: { ...unixSecParam, description: 'Optional expiry for terms acceptance.' },
    },
    required: [
      'channel',
      'trade_id',
      'btc_sats',
      'usdt_amount',
      'sol_mint',
      'sol_recipient',
      'sol_refund',
      'sol_refund_after_unix',
      'ln_receiver_peer',
      'ln_payer_peer',
      'platform_fee_bps',
      'trade_fee_bps',
      'trade_fee_collector',
    ],
  }),
  tool('intercomswap_terms_accept', 'Taker: post signed ACCEPT inside swap:<id> referencing the terms hash.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      terms_hash_hex: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$' },
    },
    required: ['channel', 'trade_id', 'terms_hash_hex'],
  }),

  // Lightning (LN) operator actions (executor must use configured backend/credentials).
  tool('intercomswap_ln_info', 'Get Lightning node info (impl/backend configured locally).', emptyParams),
  tool('intercomswap_ln_newaddr', 'Get a new on-chain BTC address from the LN node wallet.', emptyParams),
  tool('intercomswap_ln_listfunds', 'Get on-chain + channel balances.', emptyParams),
  tool('intercomswap_ln_connect', 'Connect to a Lightning peer (nodeid@host:port).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      peer: { type: 'string', minLength: 10, maxLength: 200, description: 'nodeid@host:port' },
    },
    required: ['peer'],
  }),
  tool('intercomswap_ln_fundchannel', 'Open a Lightning channel to a peer.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      node_id: { type: 'string', minLength: 66, maxLength: 66, pattern: '^[0-9a-fA-F]{66}$' },
      amount_sats: { type: 'integer', minimum: 1_000, maximum: 10_000_000_000 },
      private: { type: 'boolean', description: 'Prefer private channels for swaps.' },
    },
    required: ['node_id', 'amount_sats'],
  }),
  tool('intercomswap_ln_invoice_create', 'Create a standard BOLT11 invoice (no hodl invoices).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      amount_msat: { type: 'integer', minimum: 1, maximum: 21_000_000 * 100_000_000 * 1000 },
      label: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', minLength: 1, maxLength: 500 },
      expiry_sec: { type: 'integer', minimum: 60, maximum: 60 * 60 * 24 * 7 },
    },
    required: ['amount_msat', 'label', 'description'],
  }),
  tool('intercomswap_ln_decodepay', 'Decode a BOLT11 invoice offline.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      bolt11: { type: 'string', minLength: 20, maxLength: 8000 },
    },
    required: ['bolt11'],
  }),
  tool('intercomswap_ln_pay', 'Pay a BOLT11 invoice.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      bolt11: { type: 'string', minLength: 20, maxLength: 8000 },
    },
    required: ['bolt11'],
  }),
  tool('intercomswap_ln_pay_status', 'Query payment status by payment_hash.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
    },
    required: ['payment_hash_hex'],
  }),
  tool('intercomswap_ln_preimage_get', 'Get a payment preimage by payment_hash (for recovery).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
    },
    required: ['payment_hash_hex'],
  }),

  // Swap settlement helpers (deterministic; sign + send swap envelopes).
  tool('intercomswap_swap_ln_invoice_create_and_post', 'Maker: create an LN invoice and post LN_INVOICE into swap:<id>.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      btc_sats: satsParam,
      label: { type: 'string', minLength: 1, maxLength: 120 },
      description: { type: 'string', minLength: 1, maxLength: 500 },
      expiry_sec: { type: 'integer', minimum: 60, maximum: 60 * 60 * 24 * 7 },
    },
    required: ['channel', 'trade_id', 'btc_sats', 'label', 'description'],
  }),
  tool(
    'intercomswap_swap_sol_escrow_init_and_post',
    'Maker: init Solana escrow and post SOL_ESCROW_CREATED into swap:<id>.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: channelParam,
        trade_id: { type: 'string', minLength: 1, maxLength: 128 },
        payment_hash_hex: hex32Param,
        mint: base58Param,
        amount: atomicAmountParam,
        recipient: base58Param,
        refund: base58Param,
        refund_after_unix: unixSecParam,
        platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
        trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
        trade_fee_collector: base58Param,
      },
      required: [
        'channel',
        'trade_id',
        'payment_hash_hex',
        'mint',
        'amount',
        'recipient',
        'refund',
        'refund_after_unix',
        'platform_fee_bps',
        'trade_fee_bps',
        'trade_fee_collector',
      ],
    }
  ),
  tool('intercomswap_swap_ln_pay_and_post', 'Taker: pay the LN invoice and post LN_PAID into swap:<id>.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      bolt11: { type: 'string', minLength: 20, maxLength: 8000 },
      payment_hash_hex: hex32Param,
    },
    required: ['channel', 'trade_id', 'bolt11', 'payment_hash_hex'],
  }),
  tool('intercomswap_swap_sol_claim_and_post', 'Taker: claim Solana escrow and post SOL_CLAIMED into swap:<id>.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      channel: channelParam,
      trade_id: { type: 'string', minLength: 1, maxLength: 128 },
      preimage_hex: {
        anyOf: [
          { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$' },
          { type: 'string', minLength: 8, maxLength: 200, pattern: '^secret:[0-9a-fA-F-]+$' },
        ],
      },
      mint: base58Param,
    },
    required: ['channel', 'trade_id', 'preimage_hex', 'mint'],
  }),

  // Solana escrow / program ops (executor must use configured RPC + keypairs).
  tool('intercomswap_sol_balance', 'Get SOL balance for a pubkey.', {
    type: 'object',
    additionalProperties: false,
    properties: { pubkey: base58Param },
    required: ['pubkey'],
  }),
  tool('intercomswap_sol_token_balance', 'Get SPL token balance for a (owner,mint) pair (ATA).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      owner: base58Param,
      mint: base58Param,
    },
    required: ['owner', 'mint'],
  }),
  tool('intercomswap_sol_escrow_get', 'Fetch escrow state by payment_hash (and mint).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
      mint: base58Param,
    },
    required: ['payment_hash_hex', 'mint'],
  }),
  tool('intercomswap_sol_escrow_init', 'Initialize an escrow locked to LN payment_hash.', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
      mint: base58Param,
      amount: atomicAmountParam,
      recipient: base58Param,
      refund: base58Param,
      refund_after_unix: unixSecParam,
      platform_fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
      trade_fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
      trade_fee_collector: base58Param,
      platform_fee_collector: { ...base58Param, description: 'Optional override, else use program config.' },
    },
    required: [
      'payment_hash_hex',
      'mint',
      'amount',
      'recipient',
      'refund',
      'refund_after_unix',
      'platform_fee_bps',
      'trade_fee_bps',
      'trade_fee_collector',
    ],
  }),
  tool('intercomswap_sol_escrow_claim', 'Claim escrow by submitting LN preimage (recipient signature required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      preimage_hex: {
        anyOf: [
          { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$' },
          { type: 'string', minLength: 8, maxLength: 200, pattern: '^secret:[0-9a-fA-F-]+$' },
        ],
        description: '32-byte hex preimage, or a secret handle returned by promptd (secret:<id>).',
      },
      mint: base58Param,
    },
    required: ['preimage_hex', 'mint'],
  }),
  tool('intercomswap_sol_escrow_refund', 'Refund escrow after timeout (refund signature required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      payment_hash_hex: hex32Param,
      mint: base58Param,
    },
    required: ['payment_hash_hex', 'mint'],
  }),
  tool('intercomswap_sol_config_get', 'Get program fee config (platform config PDA).', emptyParams),
  tool('intercomswap_sol_config_set', 'Set program fee config (admin authority required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      fee_bps: { type: 'integer', minimum: 0, maximum: 500 },
      fee_collector: base58Param,
    },
    required: ['fee_bps', 'fee_collector'],
  }),
  tool('intercomswap_sol_fees_withdraw', 'Withdraw accrued platform fees from fee vault (admin authority required).', {
    type: 'object',
    additionalProperties: false,
    properties: {
      mint: base58Param,
      to: base58Param,
      amount: atomicAmountParam,
    },
    required: ['mint', 'to', 'amount'],
  }),

  tool(
    'intercomswap_sol_trade_config_get',
    'Get trade fee config (per fee_collector).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        fee_collector: base58Param,
      },
      required: ['fee_collector'],
    }
  ),
  tool(
    'intercomswap_sol_trade_config_set',
    'Init/set trade fee config (fee_collector authority required).',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        fee_bps: { type: 'integer', minimum: 0, maximum: 1000 },
        fee_collector: base58Param,
      },
      required: ['fee_bps', 'fee_collector'],
    }
  ),
  tool(
    'intercomswap_sol_trade_fees_withdraw',
    'Withdraw accrued trade fees for the configured fee_collector.',
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mint: base58Param,
        to: base58Param,
        amount: atomicAmountParam,
      },
      required: ['mint', 'to', 'amount'],
    }
  ),

  // Receipts / recovery (local-only, deterministic).
  tool('intercomswap_receipts_list', 'List local trade receipts (sqlite).', emptyParams),
  tool('intercomswap_receipts_show', 'Show a local receipt by trade_id.', {
    type: 'object',
    additionalProperties: false,
    properties: { trade_id: { type: 'string', minLength: 1, maxLength: 128 } },
    required: ['trade_id'],
  }),
];
