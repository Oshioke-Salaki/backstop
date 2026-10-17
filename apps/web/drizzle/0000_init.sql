CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"label" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"escrow_id" text NOT NULL,
	"reason" text NOT NULL,
	"payer_statement" text NOT NULL,
	"provider_statement" text,
	"provider_responded_at" timestamp with time zone,
	"respond_by" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"payer_amount" bigint,
	"resolved_by" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "disputes_escrow_id_unique" UNIQUE("escrow_id")
);
--> statement-breakpoint
CREATE TABLE "escrows" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"payer" text NOT NULL,
	"payee" text NOT NULL,
	"amount_atomic" bigint NOT NULL,
	"fee_bps" integer,
	"nonce" text NOT NULL,
	"valid_before" bigint NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"verdict" jsonb,
	"upstream_status" integer,
	"latency_ms" integer,
	"response_hash" text,
	"deposit_tx" text,
	"settle_tx" text,
	"release_at" timestamp with time zone,
	"deadline" timestamp with time zone,
	"hard_deadline" timestamp with time zone,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"escrow_id" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"escrow_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"tx_hash" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_address" text NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"payout_address" text NOT NULL,
	"payout_approved" boolean DEFAULT false NOT NULL,
	"signing_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_owner_address_unique" UNIQUE("owner_address")
);
--> statement-breakpoint
CREATE TABLE "responses" (
	"escrow_id" text PRIMARY KEY NOT NULL,
	"http_status" integer NOT NULL,
	"headers" jsonb NOT NULL,
	"body_cipher" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"upstream_url" text NOT NULL,
	"method" text NOT NULL,
	"price_atomic" bigint NOT NULL,
	"sla" jsonb NOT NULL,
	"input_schema" jsonb,
	"dispute_window_seconds" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"address" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_escrow_id_escrows_id_fk" FOREIGN KEY ("escrow_id") REFERENCES "public"."escrows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrows" ADD CONSTRAINT "escrows_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_owner_address_users_address_fk" FOREIGN KEY ("owner_address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_escrow_id_escrows_id_fk" FOREIGN KEY ("escrow_id") REFERENCES "public"."escrows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_provider_idx" ON "api_keys" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "disputes_status_idx" ON "disputes" USING btree ("status","respond_by");--> statement-breakpoint
CREATE INDEX "escrows_status_release_idx" ON "escrows" USING btree ("status","release_at");--> statement-breakpoint
CREATE INDEX "escrows_service_created_idx" ON "escrows" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "escrows_payer_created_idx" ON "escrows" USING btree ("payer","created_at");--> statement-breakpoint
CREATE INDEX "escrows_status_updated_idx" ON "escrows" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "events_escrow_idx" ON "events" USING btree ("escrow_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_idx" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "responses_expires_idx" ON "responses" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "services_provider_idx" ON "services" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "services_status_idx" ON "services" USING btree ("status");