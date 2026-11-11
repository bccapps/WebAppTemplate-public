-- Reference DDL of the interaction module (SQLite), generated from the entities by ddl.sqlite.spec.ts.

CREATE TABLE "interaction_delivery" ("id" varchar PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "dedup_key" varchar(140) NOT NULL, "kind" varchar(16) NOT NULL, "category" varchar(12) NOT NULL, "type" varchar(64) NOT NULL, "ticket_id" varchar, "status" varchar(10) NOT NULL, "code" varchar(64), "created_at" datetime NOT NULL DEFAULT (datetime('now')), "sent_at" datetime);

CREATE TABLE "interaction_link_code" ("id" varchar PRIMARY KEY NOT NULL, "bot_ref" varchar(16) NOT NULL, "user_id" integer, "code_hash" varchar(64) NOT NULL, "expires_at" datetime NOT NULL, "used_at" datetime, "outcome" varchar(16), "created_at" datetime NOT NULL DEFAULT (datetime('now')));

CREATE TABLE "interaction_notice" ("id" varchar PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "type" varchar(64) NOT NULL, "source" varchar(40) NOT NULL, "category" varchar(12) NOT NULL, "priority" varchar(8) NOT NULL, "title" text NOT NULL, "body" text, "url" varchar(512), "data" text, "ticket_id" varchar, "created_at" datetime NOT NULL DEFAULT (datetime('now')), "read_at" datetime);

CREATE TABLE "interaction_secret" ("id" varchar PRIMARY KEY NOT NULL, "kind" varchar(24) NOT NULL, "owner_user_id" integer, "ciphertext" text NOT NULL, "created_at" datetime NOT NULL DEFAULT (datetime('now')), "rotated_at" datetime, "last_used_at" datetime);

CREATE TABLE "interaction_send_counter" ("id" varchar PRIMARY KEY NOT NULL, "kind" varchar(16) NOT NULL, "user_id" integer NOT NULL, "ip" varchar(64), "target_hash" varchar(64), "at" datetime NOT NULL);

CREATE TABLE "interaction_telegram_bot" ("id" varchar(16) PRIMARY KEY NOT NULL, "enabled" boolean NOT NULL DEFAULT (0), "bot_id" varchar(32), "update_offset" varchar(20), "status" varchar(16) NOT NULL DEFAULT ('off'), "last_error" varchar(64), "last_error_at" datetime, "failures" integer NOT NULL DEFAULT (0), "retry_at" datetime, "last_poll_at" datetime, "last_update_at" datetime, "last_message_at" datetime, "received_count" integer NOT NULL DEFAULT (0), "ignored_count" integer NOT NULL DEFAULT (0), "rejected_count" integer NOT NULL DEFAULT (0), "last_rejection" varchar(64), "sent_count" integer NOT NULL DEFAULT (0), "dropped_count" integer NOT NULL DEFAULT (0), "lease_owner" varchar(64), "lease_until" datetime, "updated_at" datetime NOT NULL DEFAULT (datetime('now')));

CREATE TABLE "interaction_telegram_link" ("id" varchar PRIMARY KEY NOT NULL, "bot_ref" varchar(16) NOT NULL, "user_id" integer, "telegram_user_id" varchar(20) NOT NULL, "chat_id" varchar(32) NOT NULL, "label" varchar(64), "source" varchar(16) NOT NULL, "created_at" datetime NOT NULL DEFAULT (datetime('now')));

CREATE TABLE "interaction_telegram_update" ("bot_ref" varchar(16) NOT NULL, "update_id" varchar(20) NOT NULL, "seen_at" datetime NOT NULL, PRIMARY KEY ("bot_ref", "update_id"));

CREATE TABLE "interaction_ticket" ("id" varchar PRIMARY KEY NOT NULL, "source" varchar(40) NOT NULL, "kind" varchar(64) NOT NULL, "correlation_id" varchar(128) NOT NULL, "category" varchar(12) NOT NULL, "summary" text NOT NULL, "actions" text NOT NULL, "answerable_from" text, "fresh_proof" boolean NOT NULL DEFAULT (0), "status" varchar(12) NOT NULL, "expires_at" datetime NOT NULL, "answer_action" varchar(16), "answered_via" varchar(16), "answered_by" integer, "answered_at" datetime, "cancel_reason" varchar(64), "dispatch_status" varchar(10) NOT NULL DEFAULT ('none'), "dispatch_attempts" integer NOT NULL DEFAULT (0), "dispatch_next_at" datetime, "created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')));

CREATE TABLE "interaction_ticket_card" ("id" varchar PRIMARY KEY NOT NULL, "ticket_id" varchar NOT NULL, "user_id" integer NOT NULL, "kind" varchar(16) NOT NULL, "card_key" varchar(16) NOT NULL, "binding" text NOT NULL, "state" varchar(8) NOT NULL, "lang" varchar(5) NOT NULL, "created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')));

CREATE TABLE "interaction_ticket_recipient" ("ticket_id" varchar NOT NULL, "user_id" integer NOT NULL, "notified_at" datetime NOT NULL, "seen_at" datetime, PRIMARY KEY ("ticket_id", "user_id"));

CREATE TABLE "interaction_user_channel" ("id" varchar PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "kind" varchar(16) NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), "admin_disabled" boolean NOT NULL DEFAULT (0), "admin_disabled_by" integer, "admin_disabled_at" datetime, "position" integer NOT NULL DEFAULT (0), "config" text NOT NULL, "verification" text, "secret_id" varchar, "external_key" varchar(64), "verified_at" datetime, "last_test_at" datetime, "last_test_status" varchar(8), "last_test_error" varchar(64), "last_used_at" datetime, "last_error" varchar(64), "created_at" datetime NOT NULL DEFAULT (datetime('now')), "updated_at" datetime NOT NULL DEFAULT (datetime('now')));

CREATE TABLE "interaction_user_pref" ("user_id" integer PRIMARY KEY NOT NULL, "quiet_hours_start" varchar(5), "quiet_hours_end" varchar(5), "timezone" varchar(64), "critical_bypass" boolean NOT NULL DEFAULT (1), "routing" text, "inapp_display" varchar(8), "updated_at" datetime NOT NULL DEFAULT (datetime('now')));

CREATE TABLE "interaction_webpush_subscription" ("id" varchar PRIMARY KEY NOT NULL, "user_id" integer NOT NULL, "endpoint" text NOT NULL, "p256dh" varchar(256) NOT NULL, "auth" varchar(256) NOT NULL, "user_agent" varchar(256), "created_at" datetime NOT NULL DEFAULT (datetime('now')), "last_used_at" datetime);

CREATE INDEX "IDX_ix_delivery_kind_created" ON "interaction_delivery" ("kind", "created_at") ;

CREATE INDEX "IDX_ix_delivery_user_kind" ON "interaction_delivery" ("user_id", "kind", "created_at") ;

CREATE INDEX "IDX_ix_link_code_bot" ON "interaction_link_code" ("bot_ref") ;

CREATE INDEX "IDX_ix_notice_user_read" ON "interaction_notice" ("user_id", "read_at", "created_at") ;

CREATE INDEX "IDX_ix_send_kind_at" ON "interaction_send_counter" ("kind", "at") ;

CREATE INDEX "IDX_ix_send_kind_ip" ON "interaction_send_counter" ("kind", "ip", "at") ;

CREATE INDEX "IDX_ix_send_kind_target" ON "interaction_send_counter" ("kind", "target_hash", "at") ;

CREATE INDEX "IDX_ix_send_kind_user" ON "interaction_send_counter" ("kind", "user_id", "at") ;

CREATE INDEX "IDX_ix_tg_link_account" ON "interaction_telegram_link" ("telegram_user_id") ;

CREATE INDEX "IDX_ix_tg_link_user" ON "interaction_telegram_link" ("user_id") ;

CREATE INDEX "IDX_ix_tg_update_seen" ON "interaction_telegram_update" ("seen_at") ;

CREATE INDEX "IDX_ix_ticket_card_ticket" ON "interaction_ticket_card" ("ticket_id") ;

CREATE INDEX "IDX_ix_ticket_dispatch" ON "interaction_ticket" ("dispatch_status", "dispatch_next_at") ;

CREATE INDEX "IDX_ix_ticket_recipient_user" ON "interaction_ticket_recipient" ("user_id") ;

CREATE INDEX "IDX_ix_ticket_status_exp" ON "interaction_ticket" ("status", "expires_at") ;

CREATE INDEX "IDX_ix_webpush_user" ON "interaction_webpush_subscription" ("user_id") ;

CREATE UNIQUE INDEX "UQ_ix_delivery_dedup" ON "interaction_delivery" ("user_id", "dedup_key", "kind") ;

CREATE UNIQUE INDEX "UQ_ix_link_code_hash" ON "interaction_link_code" ("code_hash") ;

CREATE UNIQUE INDEX "UQ_ix_tg_link_bot_account" ON "interaction_telegram_link" ("bot_ref", "telegram_user_id") ;

CREATE UNIQUE INDEX "UQ_ix_ticket_card_key" ON "interaction_ticket_card" ("card_key") ;

CREATE UNIQUE INDEX "UQ_ix_ticket_correlation" ON "interaction_ticket" ("source", "correlation_id") ;

CREATE UNIQUE INDEX "UQ_ix_user_channel_kind_key" ON "interaction_user_channel" ("kind", "external_key") ;

CREATE UNIQUE INDEX "UQ_ix_user_channel_user_kind" ON "interaction_user_channel" ("user_id", "kind") ;

CREATE UNIQUE INDEX "UQ_ix_webpush_endpoint" ON "interaction_webpush_subscription" ("endpoint") ;
