/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Extracted from AgentHub (`services/conversationSecrets.ts`, 04 §13): masks the well-known SHAPES of keys and tokens in a
// text before it is rendered or stored. Pure. Masking too much is accepted, leaking a key is not. Additions for this
// module: Telegram bot tokens, webhook signing keys (`whsec_`), and the Stripe-like `sk_live_` / `rk_live_` keys.

export const SECRET_MASK = '[secret hidden]';

const TOKEN_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (`sk-ant-…`), OpenRouter (`sk-or-…`), DeepSeek
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret / restricted keys
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
  /\bac_live_[A-Za-z0-9_-]{16,}/g, // AgentHub API keys
  /\bwhsec_[A-Za-z0-9_-]{16,}/g, // webhook signing keys
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token (`<bot id>:<secret>`)
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

/** `Authorization: Bearer <token>`: the scheme stays readable. */
const AUTH_HEADER = /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{20,})/gi;

/** `text` with every well-known key / token shape replaced by `SECRET_MASK`. */
export function maskKnownSecrets(text: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, SECRET_MASK);
  return out.replace(AUTH_HEADER, (_match, scheme: string, space: string) => `${scheme}${space}${SECRET_MASK}`);
}
