CREATE TABLE "user_roles" (
	"user_sub" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_roles_user_sub_role_pk" PRIMARY KEY("user_sub","role"),
	CONSTRAINT "user_roles_role_check" CHECK ("user_roles"."role" IN ('admin', 'auditor'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"sub" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_sub_users_sub_fk" FOREIGN KEY ("user_sub") REFERENCES "public"."users"("sub") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_roles_user_sub_idx" ON "user_roles" USING btree ("user_sub");