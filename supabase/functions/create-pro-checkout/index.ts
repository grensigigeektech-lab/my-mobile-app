import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { appUrl, getServerSecret, getStripe } from '../_shared/stripe.ts';
import { getAuthedUser } from '../_shared/supabase.ts';

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
    const stripe = await getStripe(admin);
    const priceId = await getServerSecret(admin, 'STRIPE_PRO_PRICE_ID');

    if (!priceId) {
      throw new Error('STRIPE_PRO_PRICE_ID is not configured.');
    }

    const { data: profile } = await admin
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .maybeSingle();

    const { data: existingCustomer } = await admin
      .from('billing_customers')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    let customerId = existingCustomer?.stripe_customer_id as string | undefined;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: profile?.full_name ?? user.email,
        metadata: {
          supabase_user_id: user.id,
        },
      });

      customerId = customer.id;

      await admin.from('billing_customers').upsert({
        user_id: user.id,
        stripe_customer_id: customerId,
      });
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: appUrl('checkout/success?kind=subscription'),
      cancel_url: appUrl('checkout/cancel?kind=subscription'),
      allow_promotion_codes: true,
      client_reference_id: user.id,
      metadata: {
        user_id: user.id,
        plan_tier: 'pro',
      },
      subscription_data: {
        metadata: {
          user_id: user.id,
          plan_tier: 'pro',
        },
      },
    });

    return jsonResponse({ url: checkoutSession.url });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Checkout failed.' },
      400,
    );
  }
});
