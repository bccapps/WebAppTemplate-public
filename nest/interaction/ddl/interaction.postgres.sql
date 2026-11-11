-- Reference DDL of the interaction module (Postgres), generated from the entities by ddl.postgres.spec.ts.
-- Needs the uuid-ossp extension (CREATE EXTENSION IF NOT EXISTS "uuid-ossp") for the generated uuid ids.

CREATE TABLE "interaction_delivery" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" integer NOT NULL, "dedup_key" character varying(140) NOT NULL, "kind" character varying(16) NOT NULL, "category" character varying(12) NOT NULL, "type" character varying(64) NOT NULL, "ticket_id" uuid, "status" character varying(10) NOT NULL, "code" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "sent_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_cd272e3e293570f2f77ef7ce27c" PRIMARY KEY ("id"));

CREATE INDEX "IDX_ix_delivery_kind_created" ON "interaction_delivery"  ("kind", "created_at") ;

CREATE INDEX "IDX_ix_delivery_user_kind" ON "interaction_delivery"  ("user_id", "kind", "created_at") ;

CREATE UNIQUE INDEX "UQ_ix_delivery_dedup" ON "interaction_delivery"  ("user_id", "dedup_key", "kind") ;

CREATE TABLE "interaction_link_code" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "bot_ref" character varying(16) NOT NULL, "user_id" integer, "code_hash" character varying(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "outcome" character varying(16), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_2f3db5c9902325d6c9d3ebcdc75" PRIMARY KEY ("id"));

CREATE INDEX "IDX_ix_link_code_bot" ON "interaction_link_code"  ("bot_ref") ;

CREATE UNIQUE INDEX "UQ_ix_link_code_hash" ON "interaction_link_code"  ("code_hash") ;

CREATE TABLE "interaction_notice" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" integer NOT NULL, "type" character varying(64) NOT NULL, "source" character varying(40) NOT NULL, "category" character varying(12) NOT NULL, "priority" character varying(8) NOT NULL, "title" jsonb NOT NULL, "body" jsonb, "url" character varying(512), "data" jsonb, "ticket_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "read_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_560064f46aaf640c17b91a99ecc" PRIMARY KEY ("id"));

CREATE INDEX "IDX_ix_notice_user_read" ON "interaction_notice"  ("user_id", "read_at", "created_at") ;

CREATE TABLE "interaction_secret" ("id" uuid NOT NULL, "kind" character varying(24) NOT NULL, "owner_user_id" integer, "ciphertext" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "rotated_at" TIMESTAMP WITH TIME ZONE, "last_used_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_deccc570efed31752b85e77178f" PRIMARY KEY ("id"));

CREATE TABLE "interaction_send_counter" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "kind" character varying(16) NOT NULL, "user_id" integer NOT NULL, "ip" character varying(64), "target_hash" character varying(64), "at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_28d22bbd7615cfadbab3e2ba1b9" PRIMARY KEY ("id"));

CREATE INDEX "IDX_ix_send_kind_target" ON "interaction_send_counter"  ("kind", "target_hash", "at") ;

CREATE INDEX "IDX_ix_send_kind_ip" ON "interaction_send_counter"  ("kind", "ip", "at") ;

CREATE INDEX "IDX_ix_send_kind_user" ON "interaction_send_counter"  ("kind", "user_id", "at") ;

CREATE INDEX "IDX_ix_send_kind_at" ON "interaction_send_counter"  ("kind", "at") ;

CREATE TABLE "interaction_telegram_bot" ("id" character varying(16) NOT NULL, "enabled" boolean NOT NULL DEFAULT false, "bot_id" character varying(32), "update_offset" character varying(20), "status" character varying(16) NOT NULL DEFAULT 'off', "last_error" character varying(64), "last_error_at" TIMESTAMP WITH TIME ZONE, "failures" integer NOT NULL DEFAULT '0', "retry_at" TIMESTAMP WITH TIME ZONE, "last_poll_at" TIMESTAMP WITH TIME ZONE, "last_update_at" TIMESTAMP WITH TIME ZONE, "last_message_at" TIMESTAMP WITH TIME ZONE, "received_count" integer NOT NULL DEFAULT '0', "ignored_count" integer NOT NULL DEFAULT '0', "rejected_count" integer NOT NULL DEFAULT '0', "last_rejection" character varying(64), "sent_count" integer NOT NULL DEFAULT '0', "dropped_count" integer NOT NULL DEFAULT '0', "lease_owner" character varying(64), "lease_until" TIMESTAMP WITH TIME ZONE, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_bf313a75220c562f6a5615acbae" PRIMARY KEY ("id"));

CREATE TABLE "interaction_telegram_link" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "bot_ref" character varying(16) NOT NULL, "user_id" integer, "telegram_user_id" character varying(20) NOT NULL, "chat_id" character varying(32) NOT NULL, "label" character varying(64), "source" character varying(16) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7c5222463fc2815dabc1103ee9e" PRIMARY KEY ("id"));

CREATE INDEX "IDX_ix_tg_link_user" ON "interaction_telegram_link"  ("user_id") ;

CREATE INDEX "IDX_ix_tg_link_account" ON "interaction_telegram_link"  ("telegram_user_id") ;

CREATE UNIQUE INDEX "UQ_ix_tg_link_bot_account" ON "interaction_telegram_link"  ("bot_ref", "telegram_user_id") ;

CREATE TABLE "interaction_telegram_update" ("bot_ref" character varying(16) NOT NULL, "update_id" character varying(20) NOT NULL, "seen_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_a7b4a747fc547409092d6dba83f" PRIMARY KEY ("bot_ref", "update_id"));

CREATE INDEX "IDX_ix_tg_update_seen" ON "interaction_telegram_update"  ("seen_at") ;

CREATE TABLE "interaction_ticket_card" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ticket_id" uuid NOT NULL, "user_id" integer NOT NULL, "kind" character varying(16) NOT NULL, "card_key" character varying(16) NOT NULL, "binding" jsonb NOT NULL, "state" character varying(8) NOT NULL, "lang" character varying(5) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ed9a75f7f5a27b2f3a1a2a1ea94" PRIMARY KEY ("id"));

CREATE INDEX "IDX_ix_ticket_card_ticket" ON "interaction_ticket_card"  ("ticket_id") ;

CREATE UNIQUE INDEX "UQ_ix_ticket_card_key" ON "interaction_ticket_card"  ("card_key") ;

CREATE TABLE "interaction_ticket" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "source" character varying(40) NOT NULL, "kind" character varying(64) NOT NULL, "correlation_id" character varying(128) NOT NULL, "category" character varying(12) NOT NULL, "summary" jsonb NOT NULL, "actions" jsonb NOT NULL, "answerable_from" jsonb, "fresh_proof" boolean NOT NULL DEFAULT false, "status" character varying(12) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "answer_action" character varying(16), "answered_via" character varying(16), "answered_by" integer, "answered_at" TIMESTAMP WITH TIME ZONE, "cancel_reason" character varying(64), "dispatch_status" character varying(10) NOT NULL DEFAULT 'none', "dispatch_attempts" integer NOT NULL DEFAULT '0', "dispatch_next_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_44b63db4668698b5808d76d135d" PRIMARY KEY ("id"));

CREATE INDEX "IDX_ix_ticket_dispatch" ON "interaction_ticket"  ("dispatch_status", "dispatch_next_at") ;

CREATE INDEX "IDX_ix_ticket_status_exp" ON "interaction_ticket"  ("status", "expires_at") ;

CREATE UNIQUE INDEX "UQ_ix_ticket_correlation" ON "interaction_ticket"  ("source", "correlation_id") ;

CREATE TABLE "interaction_ticket_recipient" ("ticket_id" uuid NOT NULL, "user_id" integer NOT NULL, "notified_at" TIMESTAMP WITH TIME ZONE NOT NULL, "seen_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_f0b473138ce579e253a5900bdd6" PRIMARY KEY ("ticket_id", "user_id"));

CREATE INDEX "IDX_ix_ticket_recipient_user" ON "interaction_ticket_recipient"  ("user_id") ;

CREATE TABLE "interaction_user_channel" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" integer NOT NULL, "kind" character varying(16) NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "admin_disabled" boolean NOT NULL DEFAULT false, "admin_disabled_by" integer, "admin_disabled_at" TIMESTAMP WITH TIME ZONE, "position" integer NOT NULL DEFAULT '0', "config" jsonb NOT NULL, "verification" jsonb, "secret_id" uuid, "external_key" character varying(64), "verified_at" TIMESTAMP WITH TIME ZONE, "last_test_at" TIMESTAMP WITH TIME ZONE, "last_test_status" character varying(8), "last_test_error" character varying(64), "last_used_at" TIMESTAMP WITH TIME ZONE, "last_error" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_711435c36de1d691b90480c1c17" PRIMARY KEY ("id"));

CREATE UNIQUE INDEX "UQ_ix_user_channel_kind_key" ON "interaction_user_channel"  ("kind", "external_key") ;

CREATE UNIQUE INDEX "UQ_ix_user_channel_user_kind" ON "interaction_user_channel"  ("user_id", "kind") ;

CREATE TABLE "interaction_user_pref" ("user_id" integer NOT NULL, "quiet_hours_start" character varying(5), "quiet_hours_end" character varying(5), "timezone" character varying(64), "critical_bypass" boolean NOT NULL DEFAULT true, "routing" jsonb, "inapp_display" character varying(8), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0847cb0e540d5fc23a230f52089" PRIMARY KEY ("user_id"));

CREATE TABLE "interaction_webpush_subscription" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" integer NOT NULL, "endpoint" text NOT NULL, "p256dh" character varying(256) NOT NULL, "auth" character varying(256) NOT NULL, "user_agent" character varying(256), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "last_used_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_5cdd79f93557832c65fcff8a403" PRIMARY KEY ("id"));

CREATE INDEX "IDX_ix_webpush_user" ON "interaction_webpush_subscription"  ("user_id") ;

CREATE UNIQUE INDEX "UQ_ix_webpush_endpoint" ON "interaction_webpush_subscription"  ("endpoint") ;
