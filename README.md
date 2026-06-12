# Freelance Market Mobile App

Shared React Native CLI app for a two-sided freelance marketplace. Clients and providers use the same app; onboarding assigns the role.

## What is included

- Supabase Auth sign up/sign in.
- Role onboarding for clients and providers.
- Provider profile browsing with PRO priority placement.
- Supabase-backed plan and feature access checks.
- PRO subscription checkout through Supabase Edge Functions.
- Booking checkout through Supabase Edge Functions.
- Direct messaging gated by Supabase plan state.
- Reviews for completed paid bookings.
- Stripe webhook processing with idempotent event storage.
- GitHub Actions Android APK build on pushes to `master`.

## Server-side payment boundary

The mobile app never calls Stripe directly. It only calls Supabase Edge Functions:

- `create-pro-checkout`
- `create-booking-checkout`
- `create-provider-onboarding`
- `stripe-webhook`

Stripe secrets are not committed to the repo and are not available to the mobile client.

## Supabase

The database schema lives in:

```text
supabase/migrations/20260612120000_marketplace_schema.sql
```

Plan state and feature access are read from Supabase only:

- `plans`
- `plan_features`
- `user_plan_state`
- `subscriptions`
- `provider_profiles.priority_placement`

Webhook idempotency is handled by `stripe_webhook_events.event_id`.

## GitHub Actions and Slack

Workflow:

```text
.github/workflows/android-apk.yml
```

On a successful `master` build, the workflow uploads only the APK file to `#apk`.

On failure, it sends a plain text failure summary to `#apk` using the Slack webhook.

Required GitHub secrets:

- `SLACK_WEBHOOK_URL`: incoming webhook URL for failure messages.
- `SLACK_BOT_TOKEN`: Slack bot token with `files:write` access for APK uploads.

The workflow uses channel ID `C0B9ZT30TM3` for `#apk`.

## Local commands

```bash
npm install
npm run typecheck
npm run lint
npm test -- --watchAll=false
cd android && ./gradlew assembleRelease
```

Local Android builds require an Android SDK configured through `ANDROID_HOME` or `android/local.properties`. GitHub Actions installs the needed SDK packages automatically.
