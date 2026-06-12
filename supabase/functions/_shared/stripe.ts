import Stripe from 'npm:stripe';

export const stripeApiVersion = '2026-02-25.clover';

type AdminClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{
          data: { value?: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

export async function getServerSecret(admin: AdminClient, key: string) {
  const envValue = Deno.env.get(key);

  if (envValue) {
    return envValue;
  }

  const { data, error } = await admin
    .from('server_secrets')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error || !data?.value) {
    throw new Error(`${key} is not configured.`);
  }

  return data.value;
}

export async function getStripe(admin: AdminClient) {
  const secretKey = await getServerSecret(admin, 'STRIPE_SECRET_KEY');

  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }

  return new Stripe(secretKey, {
    apiVersion: stripeApiVersion as Stripe.LatestApiVersion,
  });
}

export function appUrl(path: string) {
  const trimmed = path.startsWith('/') ? path.slice(1) : path;
  const base = Deno.env.get('APP_DEEP_LINK_BASE') ?? 'freelancemarket://';
  return `${base}${trimmed}`;
}

export async function stripeV2Request<T>(
  admin: AdminClient,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const secretKey = await getServerSecret(admin, 'STRIPE_SECRET_KEY');

  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }

  const response = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      'Stripe-Version': stripeApiVersion,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();

  if (!response.ok) {
    const message = payload?.error?.message ?? 'Stripe request failed.';
    throw new Error(message);
  }

  return payload as T;
}
