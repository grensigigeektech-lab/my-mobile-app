import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { appUrl, stripeV2Request } from '../_shared/stripe.ts';
import { getAuthedUser } from '../_shared/supabase.ts';

type StripeAccount = {
  id: string;
};

type StripeAccountLink = {
  url: string;
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
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('role,full_name,headline')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError || profile?.role !== 'provider') {
      throw new Error('Only providers can start payout onboarding.');
    }

    const { data: existingAccount } = await admin
      .from('provider_payout_accounts')
      .select('stripe_account_id')
      .eq('provider_id', user.id)
      .maybeSingle();

    let accountId = existingAccount?.stripe_account_id as string | undefined;

    if (!accountId) {
      const account = await stripeV2Request<StripeAccount>(admin, '/v2/core/accounts', {
        contact_email: user.email,
        display_name: profile.full_name ?? profile.headline ?? 'Marketplace provider',
        dashboard: 'express',
        identity: {
          country: 'us',
          entity_type: 'individual',
        },
        configuration: {
          merchant: {
            capabilities: {
              card_payments: {
                requested: true,
              },
            },
          },
        },
        defaults: {
          currency: 'usd',
          responsibilities: {
            fees_collector: 'application',
            losses_collector: 'application',
          },
          locales: ['en-US'],
        },
        include: ['configuration.merchant', 'identity', 'requirements'],
      });

      accountId = account.id;

      await admin.from('provider_payout_accounts').upsert({
        provider_id: user.id,
        stripe_account_id: accountId,
      });
    }

    const link = await stripeV2Request<StripeAccountLink>(admin, '/v2/core/account_links', {
      account: accountId,
      use_case: {
        account_onboarding: {
          configurations: ['merchant'],
          refresh_url: appUrl('provider/onboarding/refresh'),
          return_url: appUrl('provider/onboarding/return'),
          collection_options: {
            fields: 'currently_due',
            future_requirements: 'omit',
          },
        },
      },
    });

    return jsonResponse({ url: link.url });
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Provider onboarding could not be started.',
      },
      400,
    );
  }
});
