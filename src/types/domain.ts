export type UserRole = 'client' | 'provider';
export type PlanTier = 'free' | 'pro';

export type Profile = {
  id: string;
  role: UserRole | null;
  full_name: string | null;
  headline: string | null;
  bio: string | null;
  location: string | null;
  is_onboarded: boolean;
};

export type ProviderCard = {
  profile_id: string;
  categories: string[];
  hourly_rate_cents: number;
  availability: Record<string, unknown>;
  priority_placement: boolean;
  stripe_onboarding_complete: boolean;
  profiles?: {
    full_name: string | null;
    headline: string | null;
    bio: string | null;
    location: string | null;
  } | null;
};

export type PlanState = {
  plan_tier: PlanTier;
  status: string;
  current_period_end: string | null;
};

export type FeatureFlags = Record<string, boolean>;

export type Booking = {
  id: string;
  client_id: string;
  provider_id: string;
  scheduled_start: string;
  scheduled_end: string;
  amount_cents: number;
  currency: string;
  status: string;
  payment_status: string;
  notes: string | null;
};

export type Conversation = {
  id: string;
  client_id: string;
  provider_id: string;
  last_message_at: string;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};
