import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { invokeAuthed, supabase } from './src/lib/supabase';
import type {
  Booking,
  ChatMessage,
  Conversation,
  FeatureFlags,
  PlanState,
  Profile,
  ProviderCard,
  UserRole,
} from './src/types/domain';

type Tab = 'discover' | 'bookings' | 'chat' | 'account';

const SERVICE_CATEGORIES = [
  'Design',
  'Tutoring',
  'Consulting',
  'Writing',
  'Marketing',
  'Development',
];

const DEFAULT_AVAILABILITY = {
  monday: ['09:00-12:00', '14:00-17:00'],
  tuesday: ['10:00-15:00'],
  wednesday: ['09:00-12:00'],
};

function normalizeProvider(row: unknown): ProviderCard {
  const provider = row as ProviderCard & {
    profiles?: ProviderCard['profiles'] | ProviderCard['profiles'][];
  };
  const profileData = Array.isArray(provider.profiles)
    ? provider.profiles[0] ?? null
    : provider.profiles ?? null;

  return {
    ...provider,
    profiles: profileData,
  };
}

function money(cents: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function initials(name?: string | null) {
  if (!name) {
    return 'FM';
  }

  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('');
}

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [planState, setPlanState] = useState<PlanState | null>(null);
  const [features, setFeatures] = useState<FeatureFlags>({});
  const [providers, setProviders] = useState<ProviderCard[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeConversation, setActiveConversation] = useState<string | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>('discover');
  const [refreshing, setRefreshing] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [messageDraft, setMessageDraft] = useState('');

  const canBook = features.schedule_bookings === true;
  const canChat = features.direct_messaging === true;
  const hasEnhancedFilters = features.enhanced_filters === true;
  const hasAvailabilityCalendar = features.availability_calendar === true;

  const loadProfile = useCallback(async (currentSession: Session | null) => {
    if (!currentSession?.user.id) {
      setProfile(null);
      setPlanState(null);
      setFeatures({});
      return;
    }

    const userId = currentSession.user.id;

    const [{ data: profileRow, error: profileError }, { data: planRow }] =
      await Promise.all([
        supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
        supabase
          .from('user_plan_state')
          .select('plan_tier,status,current_period_end')
          .eq('user_id', userId)
          .maybeSingle(),
      ]);

    if (profileError) {
      throw profileError;
    }

    setProfile(profileRow as Profile | null);

    const nextPlan = (planRow as PlanState | null) ?? {
      plan_tier: 'free',
      status: 'active',
      current_period_end: null,
    };
    setPlanState(nextPlan);

    const { data: featureRows, error: featureError } = await supabase
      .from('plan_features')
      .select('feature_key,enabled')
      .eq('plan_tier', nextPlan.plan_tier);

    if (featureError) {
      throw featureError;
    }

    setFeatures(
      (featureRows ?? []).reduce<FeatureFlags>((acc, item) => {
        acc[item.feature_key] = item.enabled;
        return acc;
      }, {}),
    );
  }, []);

  const loadMarketplace = useCallback(async () => {
    if (!session?.user.id || !profile?.is_onboarded) {
      return;
    }

    const providerQuery = supabase
      .from('provider_profiles')
      .select(
        'profile_id,categories,hourly_rate_cents,availability,priority_placement,stripe_onboarding_complete,profiles(full_name,headline,bio,location)',
      )
      .eq('searchable', true)
      .order('priority_placement', { ascending: false })
      .order('hourly_rate_cents', { ascending: true });

    const bookingQuery =
      profile.role === 'provider'
        ? supabase
            .from('bookings')
            .select('*')
            .eq('provider_id', session.user.id)
            .order('scheduled_start', { ascending: true })
        : supabase
            .from('bookings')
            .select('*')
            .eq('client_id', session.user.id)
            .order('scheduled_start', { ascending: true });

    const conversationQuery =
      profile.role === 'provider'
        ? supabase
            .from('conversations')
            .select('*')
            .eq('provider_id', session.user.id)
            .order('last_message_at', { ascending: false })
        : supabase
            .from('conversations')
            .select('*')
            .eq('client_id', session.user.id)
            .order('last_message_at', { ascending: false });

    const [
      { data: providerRows, error: providerError },
      { data: bookingRows, error: bookingError },
      { data: conversationRows, error: conversationError },
    ] = await Promise.all([providerQuery, bookingQuery, conversationQuery]);

    if (providerError) {
      throw providerError;
    }
    if (bookingError) {
      throw bookingError;
    }
    if (conversationError) {
      throw conversationError;
    }

    setProviders((providerRows ?? []).map(normalizeProvider));
    setBookings((bookingRows ?? []) as Booking[]);
    setConversations((conversationRows ?? []) as Conversation[]);
  }, [profile?.is_onboarded, profile?.role, session]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      const {
        data: { session: currentSession },
      } = await supabase.auth.getSession();
      setSession(currentSession);
      await loadProfile(currentSession);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not refresh.');
    } finally {
      setRefreshing(false);
      setBooting(false);
    }
  }, [loadProfile]);

  useEffect(() => {
    refreshAll();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      loadProfile(nextSession).catch(error =>
        setNotice(error instanceof Error ? error.message : 'Profile load failed.'),
      );
    });

    return () => subscription.unsubscribe();
  }, [loadProfile, refreshAll]);

  useEffect(() => {
    loadMarketplace().catch(error =>
      setNotice(error instanceof Error ? error.message : 'Marketplace load failed.'),
    );
  }, [loadMarketplace]);

  useEffect(() => {
    if (!activeConversation) {
      setMessages([]);
      return;
    }

    supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', activeConversation)
      .order('created_at', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setNotice(error.message);
          return;
        }
        setMessages((data ?? []) as ChatMessage[]);
      });
  }, [activeConversation]);

  const filteredProviders = useMemo(() => {
    return providers.filter(provider => {
      const profileData = provider.profiles;
      const haystack = [
        profileData?.full_name,
        profileData?.headline,
        profileData?.bio,
        profileData?.location,
        provider.categories.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      const matchesSearch = haystack.includes(searchTerm.trim().toLowerCase());
      const matchesCategory =
        categoryFilter === 'All' || provider.categories.includes(categoryFilter);
      return matchesSearch && matchesCategory;
    });
  }, [categoryFilter, providers, searchTerm]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    setProfile(null);
    setPlanState(null);
    setFeatures({});
    setTab('discover');
  }

  async function startProCheckout() {
    setBusyLabel('Opening secure checkout');
    try {
      const response = await invokeAuthed<{ url: string }>('create-pro-checkout');
      if (!response?.url) {
        throw new Error('Checkout did not return a URL.');
      }
      await Linking.openURL(response.url);
    } catch (error) {
      Alert.alert('PRO upgrade', error instanceof Error ? error.message : 'Failed.');
    } finally {
      setBusyLabel(null);
    }
  }

  async function startProviderOnboarding() {
    setBusyLabel('Opening provider payout onboarding');
    try {
      const response = await invokeAuthed<{ url: string }>(
        'create-provider-onboarding',
      );
      if (!response?.url) {
        throw new Error('Onboarding did not return a URL.');
      }
      await Linking.openURL(response.url);
    } catch (error) {
      Alert.alert(
        'Provider onboarding',
        error instanceof Error ? error.message : 'Failed.',
      );
    } finally {
      setBusyLabel(null);
    }
  }

  async function startBooking(provider: ProviderCard) {
    if (!canBook) {
      Alert.alert('PRO feature', 'Upgrade to PRO to schedule and pay for bookings.');
      return;
    }

    setBusyLabel('Creating secure booking checkout');
    try {
      const start = new Date(Date.now() + 86400000);
      start.setMinutes(0, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const response = await invokeAuthed<{ url: string }>(
        'create-booking-checkout',
        {
          provider_id: provider.profile_id,
          scheduled_start: start.toISOString(),
          scheduled_end: end.toISOString(),
          notes: `Intro session with ${provider.profiles?.full_name ?? 'provider'}`,
        },
      );
      if (!response?.url) {
        throw new Error('Checkout did not return a URL.');
      }
      await Linking.openURL(response.url);
    } catch (error) {
      Alert.alert('Booking checkout', error instanceof Error ? error.message : 'Failed.');
    } finally {
      setBusyLabel(null);
    }
  }

  async function openConversation(provider: ProviderCard) {
    if (!canChat || !session?.user.id) {
      Alert.alert('PRO feature', 'Upgrade to PRO to message providers directly.');
      return;
    }

    setBusyLabel('Opening conversation');
    try {
      const { data, error } = await supabase
        .from('conversations')
        .upsert(
          {
            client_id: session.user.id,
            provider_id: provider.profile_id,
          },
          { onConflict: 'client_id,provider_id' },
        )
        .select('*')
        .single();

      if (error) {
        throw error;
      }

      setActiveConversation((data as Conversation).id);
      setTab('chat');
      await loadMarketplace();
    } catch (error) {
      Alert.alert('Messaging', error instanceof Error ? error.message : 'Failed.');
    } finally {
      setBusyLabel(null);
    }
  }

  async function sendMessage() {
    if (!activeConversation || !messageDraft.trim() || !session?.user.id) {
      return;
    }

    const body = messageDraft.trim();
    setMessageDraft('');
    const { error } = await supabase.from('messages').insert({
      conversation_id: activeConversation,
      sender_id: session.user.id,
      body,
    });

    if (error) {
      setNotice(error.message);
      setMessageDraft(body);
      return;
    }

    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', activeConversation)
      .order('created_at', { ascending: true });
    setMessages((data ?? []) as ChatMessage[]);
  }

  async function submitReview(booking: Booking, rating: number) {
    const { error } = await supabase.from('reviews').insert({
      booking_id: booking.id,
      client_id: booking.client_id,
      provider_id: booking.provider_id,
      rating,
      comment: 'Great session. Review submitted from the mobile app.',
    });

    if (error) {
      Alert.alert('Review', error.message);
      return;
    }

    Alert.alert('Review saved', 'Thanks for rating the completed booking.');
  }

  if (booting) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator color="#156064" />
        <Text style={styles.mutedText}>Loading marketplace...</Text>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.screen}>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
        <AuthScreen onNotice={setNotice} />
        {notice ? <Toast message={notice} /> : null}
      </SafeAreaView>
    );
  }

  if (!profile?.is_onboarded) {
    return (
      <SafeAreaView style={styles.screen}>
        <OnboardingScreen
          userId={session.user.id}
          email={session.user.email ?? ''}
          onComplete={async () => {
            await loadProfile(session);
            await loadMarketplace();
          }}
          onNotice={setNotice}
        />
        {notice ? <Toast message={notice} /> : null}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <View style={styles.identityBadge}>
          <Text style={styles.identityText}>{initials(profile.full_name)}</Text>
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>
            {profile.role === 'provider' ? 'Provider account' : 'Client account'}
          </Text>
          <Text style={styles.title}>{profile.full_name ?? 'Freelance Market'}</Text>
        </View>
        <View style={planState?.plan_tier === 'pro' ? styles.proPill : styles.freePill}>
          <Text style={styles.pillText}>{planState?.plan_tier.toUpperCase()}</Text>
        </View>
      </View>

      <View style={styles.nav}>
        {(['discover', 'bookings', 'chat', 'account'] as Tab[]).map(item => (
          <Pressable
            key={item}
            onPress={() => setTab(item)}
            style={[styles.navItem, tab === item && styles.navItemActive]}>
            <Text style={[styles.navText, tab === item && styles.navTextActive]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              await refreshAll();
              await loadMarketplace();
            }}
          />
        }
        contentContainerStyle={styles.content}>
        {notice ? <Toast message={notice} /> : null}
        {busyLabel ? <Busy message={busyLabel} /> : null}

        {tab === 'discover' ? (
          <DiscoverTab
            providers={filteredProviders}
            role={profile.role}
            categoryFilter={categoryFilter}
            searchTerm={searchTerm}
            hasEnhancedFilters={hasEnhancedFilters}
            hasAvailabilityCalendar={hasAvailabilityCalendar}
            onCategoryChange={setCategoryFilter}
            onSearchChange={setSearchTerm}
            onBook={startBooking}
            onChat={openConversation}
            canBook={canBook}
            canChat={canChat}
          />
        ) : null}

        {tab === 'bookings' ? (
          <BookingsTab bookings={bookings} onReview={submitReview} />
        ) : null}

        {tab === 'chat' ? (
          <ChatTab
            conversations={conversations}
            activeConversation={activeConversation}
            messages={messages}
            messageDraft={messageDraft}
            canChat={canChat}
            currentUserId={session.user.id}
            onPick={setActiveConversation}
            onDraft={setMessageDraft}
            onSend={sendMessage}
          />
        ) : null}

        {tab === 'account' ? (
          <AccountTab
            profile={profile}
            planState={planState}
            features={features}
            onUpgrade={startProCheckout}
            onProviderOnboarding={startProviderOnboarding}
            onSignOut={handleSignOut}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function AuthScreen({
  onNotice,
}: {
  onNotice: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(mode: 'signin' | 'signup') {
    setLoading(true);
    onNotice(null);
    const credentials = { email: email.trim(), password };
    const { error } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword(credentials)
        : await supabase.auth.signUp(credentials);
    setLoading(false);

    if (error) {
      onNotice(error.message);
      return;
    }

    if (mode === 'signup') {
      onNotice('Account created. Check email confirmation if your project requires it.');
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.authWrap}>
      <Text style={styles.heroTitle}>Freelance Market</Text>
      <Text style={styles.heroCopy}>
        One mobile app for clients and highly skilled providers.
      </Text>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>Sign in or create an account</Text>
        <TextInput
          autoCapitalize="none"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="Email"
          style={styles.input}
          value={email}
        />
        <TextInput
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          style={styles.input}
          value={password}
        />
        <PrimaryButton
          label={loading ? 'Please wait...' : 'Sign in'}
          onPress={() => submit('signin')}
        />
        <SecondaryButton label="Create account" onPress={() => submit('signup')} />
      </View>
    </ScrollView>
  );
}

function OnboardingScreen({
  userId,
  email,
  onComplete,
  onNotice,
}: {
  userId: string;
  email: string;
  onComplete: () => Promise<void>;
  onNotice: React.Dispatch<React.SetStateAction<string | null>>;
}) {
  const [role, setRole] = useState<UserRole>('client');
  const [fullName, setFullName] = useState('');
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [categories, setCategories] = useState<string[]>(['Design']);
  const [hourlyRate, setHourlyRate] = useState('7500');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    onNotice(null);
    try {
      const { error: profileError } = await supabase.from('profiles').upsert({
        id: userId,
        role,
        full_name: fullName || email,
        headline,
        bio,
        location,
        is_onboarded: true,
      });

      if (profileError) {
        throw profileError;
      }

      if (role === 'provider') {
        const cents = Math.max(Number.parseInt(hourlyRate, 10) || 0, 1000);
        const { error: providerError } = await supabase
          .from('provider_profiles')
          .upsert({
            profile_id: userId,
            categories,
            hourly_rate_cents: cents,
            availability: DEFAULT_AVAILABILITY,
            searchable: true,
          });

        if (providerError) {
          throw providerError;
        }
      }

      await onComplete();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Could not save onboarding.');
    } finally {
      setSaving(false);
    }
  }

  function toggleCategory(category: string) {
    setCategories(current =>
      current.includes(category)
        ? current.filter(item => item !== category)
        : [...current, category],
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.heroTitle}>Set up your account</Text>
      <Text style={styles.heroCopy}>
        Choose your role once. You can browse either way, but features unlock from
        Supabase plan state.
      </Text>
      <View style={styles.segmented}>
        {(['client', 'provider'] as UserRole[]).map(item => (
          <Pressable
            key={item}
            onPress={() => setRole(item)}
            style={[styles.segment, role === item && styles.segmentActive]}>
            <Text
              style={[
                styles.segmentText,
                role === item && styles.segmentTextActive,
              ]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        onChangeText={setFullName}
        placeholder="Full name"
        style={styles.input}
        value={fullName}
      />
      <TextInput
        onChangeText={setHeadline}
        placeholder="Short headline"
        style={styles.input}
        value={headline}
      />
      <TextInput
        multiline
        onChangeText={setBio}
        placeholder="Bio"
        style={[styles.input, styles.multiline]}
        value={bio}
      />
      <TextInput
        onChangeText={setLocation}
        placeholder="Location"
        style={styles.input}
        value={location}
      />

      {role === 'provider' ? (
        <View style={styles.panel}>
          <Text style={styles.sectionTitle}>Provider details</Text>
          <View style={styles.chipRow}>
            {SERVICE_CATEGORIES.map(category => (
              <Pressable
                key={category}
                onPress={() => toggleCategory(category)}
                style={[
                  styles.chip,
                  categories.includes(category) && styles.chipActive,
                ]}>
                <Text
                  style={[
                    styles.chipText,
                    categories.includes(category) && styles.chipTextActive,
                  ]}>
                  {category}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            keyboardType="number-pad"
            onChangeText={setHourlyRate}
            placeholder="Hourly rate in cents"
            style={styles.input}
            value={hourlyRate}
          />
        </View>
      ) : null}

      <PrimaryButton label={saving ? 'Saving...' : 'Continue'} onPress={save} />
    </ScrollView>
  );
}

function DiscoverTab({
  providers,
  role,
  categoryFilter,
  searchTerm,
  hasEnhancedFilters,
  hasAvailabilityCalendar,
  canBook,
  canChat,
  onCategoryChange,
  onSearchChange,
  onBook,
  onChat,
}: {
  providers: ProviderCard[];
  role: UserRole | null;
  categoryFilter: string;
  searchTerm: string;
  hasEnhancedFilters: boolean;
  hasAvailabilityCalendar: boolean;
  canBook: boolean;
  canChat: boolean;
  onCategoryChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onBook: (provider: ProviderCard) => void;
  onChat: (provider: ProviderCard) => void;
}) {
  return (
    <View>
      <Text style={styles.sectionTitle}>Discover providers</Text>
      <TextInput
        editable={hasEnhancedFilters}
        onChangeText={onSearchChange}
        placeholder={
          hasEnhancedFilters ? 'Search by skill, name, or city' : 'Upgrade to PRO for enhanced filters'
        }
        style={[styles.input, !hasEnhancedFilters && styles.inputDisabled]}
        value={searchTerm}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.chipRow}>
          {['All', ...SERVICE_CATEGORIES].map(category => (
            <Pressable
              disabled={!hasEnhancedFilters && category !== 'All'}
              key={category}
              onPress={() => onCategoryChange(category)}
              style={[
                styles.chip,
                categoryFilter === category && styles.chipActive,
                !hasEnhancedFilters && category !== 'All' && styles.disabled,
              ]}>
              <Text
                style={[
                  styles.chipText,
                  categoryFilter === category && styles.chipTextActive,
                ]}>
                {category}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      {providers.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No providers yet</Text>
          <Text style={styles.mutedText}>
            Provider profiles will appear here after onboarding.
          </Text>
        </View>
      ) : null}

      {providers.map(provider => (
        <View key={provider.profile_id} style={styles.card}>
          <View style={styles.cardHeader}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {initials(provider.profiles?.full_name)}
              </Text>
            </View>
            <View style={styles.cardTitleBlock}>
              <View style={styles.row}>
                <Text style={styles.cardTitle}>
                  {provider.profiles?.full_name ?? 'Provider'}
                </Text>
                {provider.priority_placement ? (
                  <Text style={styles.priorityTag}>PRO</Text>
                ) : null}
              </View>
              <Text style={styles.mutedText}>{provider.profiles?.headline}</Text>
            </View>
          </View>
          <Text style={styles.bodyText}>{provider.profiles?.bio}</Text>
          <Text style={styles.bodyText}>
            {money(provider.hourly_rate_cents)} per hour
          </Text>
          <View style={styles.chipRow}>
            {provider.categories.map(category => (
              <View key={category} style={styles.softChip}>
                <Text style={styles.softChipText}>{category}</Text>
              </View>
            ))}
          </View>
          {hasAvailabilityCalendar ? (
            <Text style={styles.calendarText}>
              Availability: {Object.keys(provider.availability ?? {}).join(', ')}
            </Text>
          ) : null}
          {role === 'client' ? (
            <View style={styles.actions}>
              <PrimaryButton
                label={canBook ? 'Book and pay' : 'Book (PRO)'}
                onPress={() => onBook(provider)}
              />
              <SecondaryButton
                label={canChat ? 'Message' : 'Message (PRO)'}
                onPress={() => onChat(provider)}
              />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function BookingsTab({
  bookings,
  onReview,
}: {
  bookings: Booking[];
  onReview: (booking: Booking, rating: number) => void;
}) {
  if (bookings.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>No bookings yet</Text>
        <Text style={styles.mutedText}>
          PRO clients can schedule and pay for sessions from provider profiles.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Bookings</Text>
      {bookings.map(booking => (
        <View key={booking.id} style={styles.card}>
          <Text style={styles.cardTitle}>{booking.status}</Text>
          <Text style={styles.bodyText}>
            {new Date(booking.scheduled_start).toLocaleString()}
          </Text>
          <Text style={styles.bodyText}>
            {money(booking.amount_cents, booking.currency.toUpperCase())}
          </Text>
          <Text style={styles.mutedText}>Payment: {booking.payment_status}</Text>
          {booking.status === 'completed' ? (
            <View style={styles.actions}>
              {[5, 4, 3].map(rating => (
                <SecondaryButton
                  key={rating}
                  label={`${rating} stars`}
                  onPress={() => onReview(booking, rating)}
                />
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function ChatTab({
  conversations,
  activeConversation,
  messages,
  messageDraft,
  canChat,
  currentUserId,
  onPick,
  onDraft,
  onSend,
}: {
  conversations: Conversation[];
  activeConversation: string | null;
  messages: ChatMessage[];
  messageDraft: string;
  canChat: boolean;
  currentUserId: string;
  onPick: (conversationId: string) => void;
  onDraft: (draft: string) => void;
  onSend: () => void;
}) {
  if (!canChat) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>Messaging is a PRO feature</Text>
        <Text style={styles.mutedText}>
          Upgrade from Account to start direct provider conversations.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Messages</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.chipRow}>
          {conversations.map(conversation => (
            <Pressable
              key={conversation.id}
              onPress={() => onPick(conversation.id)}
              style={[
                styles.chip,
                activeConversation === conversation.id && styles.chipActive,
              ]}>
              <Text
                style={[
                  styles.chipText,
                  activeConversation === conversation.id && styles.chipTextActive,
                ]}>
                {conversation.id.slice(0, 8)}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      {!activeConversation ? (
        <Text style={styles.mutedText}>Pick a conversation from a provider card.</Text>
      ) : (
        <View style={styles.chatBox}>
          {messages.map(message => (
            <View
              key={message.id}
              style={[
                styles.messageBubble,
                message.sender_id === currentUserId && styles.messageMine,
              ]}>
              <Text style={styles.messageText}>{message.body}</Text>
              <Text style={styles.messageTime}>
                {new Date(message.created_at).toLocaleTimeString()}
              </Text>
            </View>
          ))}
          <View style={styles.messageComposer}>
            <TextInput
              onChangeText={onDraft}
              placeholder="Type a message"
              style={[styles.input, styles.messageInput]}
              value={messageDraft}
            />
            <PrimaryButton label="Send" onPress={onSend} />
          </View>
        </View>
      )}
    </View>
  );
}

function AccountTab({
  profile,
  planState,
  features,
  onUpgrade,
  onProviderOnboarding,
  onSignOut,
}: {
  profile: Profile;
  planState: PlanState | null;
  features: FeatureFlags;
  onUpgrade: () => void;
  onProviderOnboarding: () => void;
  onSignOut: () => void;
}) {
  return (
    <View>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Plan</Text>
        <Text style={styles.cardTitle}>{planState?.plan_tier.toUpperCase()}</Text>
        <Text style={styles.mutedText}>Status: {planState?.status ?? 'active'}</Text>
        {planState?.plan_tier !== 'pro' ? (
          <PrimaryButton label="Upgrade to PRO" onPress={onUpgrade} />
        ) : (
          <Text style={styles.successText}>PRO feature access is active.</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Feature access from Supabase</Text>
        {Object.entries(features).map(([key, enabled]) => (
          <View key={key} style={styles.featureRow}>
            <Text style={styles.bodyText}>{key.replace(/_/g, ' ')}</Text>
            <Text style={enabled ? styles.enabledText : styles.disabledText}>
              {enabled ? 'enabled' : 'locked'}
            </Text>
          </View>
        ))}
      </View>

      {profile.role === 'provider' ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Provider payouts</Text>
          <Text style={styles.mutedText}>
            Connect onboarding happens server-side and opens Stripe-hosted onboarding.
          </Text>
          <SecondaryButton label="Open Stripe onboarding" onPress={onProviderOnboarding} />
        </View>
      ) : null}

      <SecondaryButton label="Sign out" onPress={onSignOut} />
    </View>
  );
}

function Busy({ message }: { message: string }) {
  return (
    <View style={styles.busy}>
      <ActivityIndicator color="#156064" />
      <Text style={styles.mutedText}>{message}</Text>
    </View>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <View style={styles.toast}>
      <Text style={styles.toastText}>{message}</Text>
    </View>
  );
}

function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.primaryButton}>
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.secondaryButton}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F6F7F9',
  },
  centered: {
    alignItems: 'center',
    backgroundColor: '#F6F7F9',
    flex: 1,
    gap: 12,
    justifyContent: 'center',
  },
  authWrap: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  content: {
    gap: 16,
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderBottomColor: '#E6E8EC',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 16,
  },
  identityBadge: {
    alignItems: 'center',
    backgroundColor: '#156064',
    borderRadius: 8,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  identityText: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  headerCopy: {
    flex: 1,
  },
  eyebrow: {
    color: '#62707D',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  title: {
    color: '#17212B',
    fontSize: 22,
    fontWeight: '800',
  },
  heroTitle: {
    color: '#17212B',
    fontSize: 34,
    fontWeight: '900',
    marginBottom: 8,
  },
  heroCopy: {
    color: '#54606B',
    fontSize: 16,
    lineHeight: 23,
    marginBottom: 22,
  },
  panel: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E1E5EA',
    borderRadius: 8,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  sectionTitle: {
    color: '#17212B',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E1E5EA',
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    marginBottom: 14,
    padding: 14,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  cardTitleBlock: {
    flex: 1,
  },
  cardTitle: {
    color: '#17212B',
    flexShrink: 1,
    fontSize: 18,
    fontWeight: '800',
  },
  bodyText: {
    color: '#26323D',
    fontSize: 14,
    lineHeight: 20,
  },
  mutedText: {
    color: '#62707D',
    fontSize: 13,
    lineHeight: 19,
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderColor: '#CCD3DA',
    borderRadius: 8,
    borderWidth: 1,
    color: '#17212B',
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  inputDisabled: {
    backgroundColor: '#EEF1F4',
  },
  multiline: {
    minHeight: 98,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  segmented: {
    backgroundColor: '#E9EEF2',
    borderRadius: 8,
    flexDirection: 'row',
    marginBottom: 16,
    padding: 4,
  },
  segment: {
    alignItems: 'center',
    borderRadius: 6,
    flex: 1,
    paddingVertical: 12,
  },
  segmentActive: {
    backgroundColor: '#FFFFFF',
  },
  segmentText: {
    color: '#62707D',
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  segmentTextActive: {
    color: '#156064',
  },
  nav: {
    backgroundColor: '#FFFFFF',
    borderBottomColor: '#E6E8EC',
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  navItem: {
    alignItems: 'center',
    borderRadius: 8,
    flex: 1,
    paddingVertical: 10,
  },
  navItemActive: {
    backgroundColor: '#E7F3F2',
  },
  navText: {
    color: '#62707D',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'capitalize',
  },
  navTextActive: {
    color: '#156064',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderColor: '#CCD3DA',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  chipActive: {
    backgroundColor: '#156064',
    borderColor: '#156064',
  },
  chipText: {
    color: '#26323D',
    fontWeight: '700',
  },
  chipTextActive: {
    color: '#FFFFFF',
  },
  softChip: {
    backgroundColor: '#EEF1F4',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  softChipText: {
    color: '#26323D',
    fontWeight: '700',
  },
  avatar: {
    alignItems: 'center',
    backgroundColor: '#F2B84B',
    borderRadius: 8,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  avatarText: {
    color: '#17212B',
    fontWeight: '900',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#156064',
    borderRadius: 8,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '900',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#156064',
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  secondaryButtonText: {
    color: '#156064',
    fontWeight: '900',
  },
  freePill: {
    backgroundColor: '#E9EEF2',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  proPill: {
    backgroundColor: '#F2B84B',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  pillText: {
    color: '#17212B',
    fontSize: 12,
    fontWeight: '900',
  },
  priorityTag: {
    backgroundColor: '#F2B84B',
    borderRadius: 6,
    color: '#17212B',
    fontSize: 11,
    fontWeight: '900',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  calendarText: {
    color: '#156064',
    fontSize: 13,
    fontWeight: '700',
  },
  disabled: {
    opacity: 0.4,
  },
  emptyState: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E1E5EA',
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    padding: 24,
  },
  emptyTitle: {
    color: '#17212B',
    fontSize: 17,
    fontWeight: '800',
  },
  chatBox: {
    gap: 8,
  },
  messageBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderColor: '#E1E5EA',
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: '88%',
    padding: 10,
  },
  messageMine: {
    alignSelf: 'flex-end',
    backgroundColor: '#E7F3F2',
    borderColor: '#B7DAD7',
  },
  messageText: {
    color: '#17212B',
    fontSize: 14,
  },
  messageTime: {
    color: '#62707D',
    fontSize: 11,
    marginTop: 5,
  },
  messageComposer: {
    gap: 8,
    marginTop: 12,
  },
  messageInput: {
    minHeight: 48,
  },
  featureRow: {
    alignItems: 'center',
    borderBottomColor: '#EEF1F4',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 9,
  },
  enabledText: {
    color: '#156064',
    fontWeight: '900',
  },
  disabledText: {
    color: '#9AA4AF',
    fontWeight: '900',
  },
  successText: {
    color: '#156064',
    fontWeight: '800',
  },
  busy: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E1E5EA',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    padding: 12,
  },
  toast: {
    backgroundColor: '#17212B',
    borderRadius: 8,
    margin: 16,
    padding: 12,
  },
  toastText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
});

export default App;
