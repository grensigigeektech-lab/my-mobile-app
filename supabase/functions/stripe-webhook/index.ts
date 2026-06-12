import Stripe from 'npm:stripe';

import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { getServerSecret, getStripe } from '../_shared/stripe.ts';
import { getSupabaseAdmin } from '../_shared/supabase.ts';

const activeSubscriptionStatuses = new Set(['active', 'trialing']);

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) {
    return options;
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  const admin = getSupabaseAdmin();
  const signingSecret = await getServerSecret(
    admin,
    'STRIPE_WEBHOOK_SIGNING_SECRET',
  );

  if (!signingSecret) {
    return jsonResponse({ error: 'Webhook signing secret is not configured.' }, 500);
  }

  const stripe = await getStripe(admin);
  const signature = req.headers.get('stripe-signature');
  const rawBody = await req.text();

  if (!signature) {
    return jsonResponse({ error: 'Missing Stripe signature.' }, 400);
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      signingSecret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Invalid signature.' },
      400,
    );
  }

  const { error: insertError } = await admin.from('stripe_webhook_events').insert({
    event_id: event.id,
    type: event.type,
    payload: event as unknown as Record<string, unknown>,
    status: 'processing',
  });

  if (insertError) {
    if (insertError.code === '23505') {
      return jsonResponse({ received: true, duplicate: true });
    }
    return jsonResponse({ error: insertError.message }, 500);
  }

  try {
    await processEvent(admin, stripe, event);
    await admin
      .from('stripe_webhook_events')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('event_id', event.id);
    return jsonResponse({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook failed.';
    await admin
      .from('stripe_webhook_events')
      .update({ status: 'failed', error: message })
      .eq('event_id', event.id);
    return jsonResponse({ error: message }, 500);
  }
});

async function processEvent(
  admin: ReturnType<typeof getSupabaseAdmin>,
  stripe: Stripe,
  event: Stripe.Event,
) {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(admin, stripe, event.data.object);
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await upsertSubscription(admin, event.data.object);
      return;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(admin, event.data.object);
      return;
    default:
      if (event.type.includes('account')) {
        await handleAccountEvent(admin, event.data.object as Record<string, unknown>);
      }
  }
}

async function handleCheckoutCompleted(
  admin: ReturnType<typeof getSupabaseAdmin>,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
) {
  if (session.mode === 'subscription' && session.subscription) {
    const subscription = await stripe.subscriptions.retrieve(
      String(session.subscription),
    );
    await upsertSubscription(admin, subscription, session);
    return;
  }

  if (session.mode === 'payment') {
    const bookingId = session.metadata?.booking_id ?? session.client_reference_id;

    if (!bookingId) {
      throw new Error('Payment checkout is missing booking metadata.');
    }

    await admin
      .from('bookings')
      .update({
        status: 'scheduled',
        payment_status: 'paid',
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent
          ? String(session.payment_intent)
          : null,
      })
      .eq('id', bookingId);
  }
}

async function upsertSubscription(
  admin: ReturnType<typeof getSupabaseAdmin>,
  subscription: Stripe.Subscription,
  session?: Stripe.Checkout.Session,
) {
  const userId =
    subscription.metadata?.user_id ??
    session?.metadata?.user_id ??
    session?.client_reference_id;

  if (!userId) {
    throw new Error('Subscription is missing user metadata.');
  }

  const status = subscription.status;
  const isPro = activeSubscriptionStatuses.has(status);
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;
  const priceId = subscription.items.data[0]?.price?.id ?? null;
  const customerId = String(subscription.customer ?? session?.customer ?? '');

  if (customerId) {
    await admin.from('billing_customers').upsert({
      user_id: userId,
      stripe_customer_id: customerId,
    });
  }

  await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
      stripe_price_id: priceId,
      status,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: subscription.cancel_at_period_end,
    },
    { onConflict: 'stripe_subscription_id' },
  );

  await admin.from('user_plan_state').upsert({
    user_id: userId,
    plan_tier: isPro ? 'pro' : 'free',
    status,
    current_period_end: currentPeriodEnd,
  });
}

async function handleInvoicePaymentFailed(
  admin: ReturnType<typeof getSupabaseAdmin>,
  invoice: Stripe.Invoice,
) {
  const subscriptionId = invoice.subscription ? String(invoice.subscription) : null;

  if (!subscriptionId) {
    return;
  }

  const { data: existing } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();

  if (!existing?.user_id) {
    return;
  }

  await admin
    .from('subscriptions')
    .update({ status: 'past_due' })
    .eq('stripe_subscription_id', subscriptionId);

  await admin
    .from('user_plan_state')
    .update({ plan_tier: 'free', status: 'past_due' })
    .eq('user_id', existing.user_id);
}

async function handleAccountEvent(
  admin: ReturnType<typeof getSupabaseAdmin>,
  account: Record<string, unknown>,
) {
  const accountId = String(account.id ?? '');

  if (!accountId) {
    return;
  }

  const requirements = account.requirements as
    | { disabled_reason?: string | null; currently_due?: string[] }
    | undefined;
  const onboardingComplete =
    !requirements?.disabled_reason &&
    (!requirements?.currently_due || requirements.currently_due.length === 0);

  await admin
    .from('provider_payout_accounts')
    .update({
      onboarding_complete: onboardingComplete,
      charges_enabled: onboardingComplete,
      payouts_enabled: onboardingComplete,
      last_event_at: new Date().toISOString(),
    })
    .eq('stripe_account_id', accountId);

  const { data: payout } = await admin
    .from('provider_payout_accounts')
    .select('provider_id,onboarding_complete')
    .eq('stripe_account_id', accountId)
    .maybeSingle();

  if (payout?.provider_id) {
    await admin
      .from('provider_profiles')
      .update({ stripe_onboarding_complete: payout.onboarding_complete })
      .eq('profile_id', payout.provider_id);
  }
}
