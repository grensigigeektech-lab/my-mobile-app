import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { appUrl, getStripe } from '../_shared/stripe.ts';
import { getAuthedUser } from '../_shared/supabase.ts';

type BookingRequest = {
  provider_id?: string;
  scheduled_start?: string;
  scheduled_end?: string;
  notes?: string;
};

Deno.serve(async (req: Request) => {
  const options = handleOptions(req);
  if (options) {
    return options;
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const { user, admin } = await getAuthedUser(req);
    const body = (await req.json()) as BookingRequest;

    if (!body.provider_id || !body.scheduled_start || !body.scheduled_end) {
      throw new Error('Provider and schedule are required.');
    }

    const { data: canBook, error: featureError } = await admin.rpc(
      'user_has_feature',
      {
        check_user_id: user.id,
        check_feature_key: 'schedule_bookings',
      },
    );

    if (featureError || canBook !== true) {
      throw new Error('A PRO plan is required to book and pay.');
    }

    const { data: provider, error: providerError } = await admin
      .from('provider_profiles')
      .select('profile_id,hourly_rate_cents,profiles(full_name)')
      .eq('profile_id', body.provider_id)
      .maybeSingle();

    if (providerError || !provider) {
      throw new Error('Provider was not found.');
    }

    const start = new Date(body.scheduled_start);
    const end = new Date(body.scheduled_end);

    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) {
      throw new Error('Booking time is invalid.');
    }

    const hours = Math.max((end.getTime() - start.getTime()) / 3600000, 1);
    const amountCents = Math.round(provider.hourly_rate_cents * hours);

    const { data: booking, error: bookingError } = await admin
      .from('bookings')
      .insert({
        client_id: user.id,
        provider_id: body.provider_id,
        scheduled_start: start.toISOString(),
        scheduled_end: end.toISOString(),
        amount_cents: amountCents,
        currency: 'usd',
        notes: body.notes ?? null,
      })
      .select('*')
      .single();

    if (bookingError || !booking) {
      throw new Error(bookingError?.message ?? 'Could not create booking.');
    }

    const stripe = await getStripe(admin);
    const providerName = provider.profiles?.full_name ?? 'Provider session';
    const { data: payoutAccount } = await admin
      .from('provider_payout_accounts')
      .select('stripe_account_id,onboarding_complete')
      .eq('provider_id', body.provider_id)
      .maybeSingle();

    const paymentIntentData: Record<string, unknown> = {
      metadata: {
        booking_id: booking.id,
        client_id: user.id,
        provider_id: body.provider_id,
      },
    };

    if (payoutAccount?.stripe_account_id && payoutAccount?.onboarding_complete) {
      paymentIntentData.transfer_data = {
        destination: payoutAccount.stripe_account_id,
      };
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: user.email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: {
              name: `Booking with ${providerName}`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: appUrl(`checkout/success?kind=booking&booking_id=${booking.id}`),
      cancel_url: appUrl(`checkout/cancel?kind=booking&booking_id=${booking.id}`),
      client_reference_id: booking.id,
      metadata: {
        booking_id: booking.id,
        client_id: user.id,
        provider_id: body.provider_id,
      },
      payment_intent_data: paymentIntentData,
    });

    await admin
      .from('bookings')
      .update({ stripe_checkout_session_id: checkoutSession.id })
      .eq('id', booking.id);

    return jsonResponse({ url: checkoutSession.url });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Booking checkout failed.' },
      400,
    );
  }
});
