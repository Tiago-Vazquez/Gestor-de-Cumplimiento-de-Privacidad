CREATE TABLE "mfa_recovery_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_sub" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mfa_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_verified_step" integer;--> statement-breakpoint
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_sub_users_sub_fk" FOREIGN KEY ("user_sub") REFERENCES "public"."users"("sub") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "mfa_recovery_codes_user_idx" ON "mfa_recovery_codes" USING btree ("user_sub");