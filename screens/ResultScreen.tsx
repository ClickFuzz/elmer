import * as FileSystem from 'expo-file-system/legacy';
import * as Clipboard from 'expo-clipboard';
import React, { useState, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../constants/colors';
import { GeneratePayload, PhotoClassification } from '../App';
import {
  saveJob,
  getBusinessProfile,
  getConnectedChannels,
  fetchServerConnectedChannels,
  ConnectedChannel,
  SeoMetadata,
  getSessionToken,
  Job,
  updateJobPublishStatus,
  JobPlatformResult,
} from '../storage/database';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3001';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

function raceTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Request timed out. Check your connection and try again.')), TIMEOUT_MS)
    ),
  ]);
}

type Props = {
  payload: GeneratePayload;
  draftJob?: Job | null;
  onBack: () => void;
  onPublishComplete?: () => void;
  onShowSettings: () => void;
};

type SuccessData = {
  googlePost: string;
  socialPost: string;
  webContent: string;
  transcription: string;
  location: string;
  seoMetadata: SeoMetadata | null;
  isMock: boolean;
};

type State =
  | { status: 'loading' }
  | ({ status: 'success' } & SuccessData)
  | { status: 'error'; message: string };

function extractMarkdownTitle(md: string): string {
  const m = md.match(/^#{1,3}\s+(.+)/m);
  return m ? m[1].trim() : '';
}

const BADGE_COLORS: Record<PhotoClassification, string> = {
  General: '#28344B',
  Before: '#5C3200',
  After: '#0D5C3A',
  Team: '#0D2E6B',
};

type PageResult = {
  pageId: string;
  pageName: string;
  platform: string;
  ok: boolean;
  postId?: string;
  postUrl?: string;
  error?: string;
  duplicate?: boolean;
  reconnect_required?: boolean;
};

type PublishState =
  | { status: 'idle' }
  | { status: 'publishing' }
  | { status: 'success'; results: PageResult[] }
  | { status: 'error'; message: string };

export default function ResultScreen({ payload, draftJob, onBack, onPublishComplete, onShowSettings }: Props) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [editedSocial, setEditedSocial] = useState('');
  const [editedThreads, setEditedThreads] = useState('');
  const [editedWordpress, setEditedWordpress] = useState('');
  const [editedWordpressTitle, setEditedWordpressTitle] = useState('');
  const [editedLocation, setEditedLocation] = useState('');
  const [excludedPlatforms, setExcludedPlatforms] = useState<Set<string>>(new Set());
  const [showVariations, setShowVariations] = useState(false);
  const [showSeo, setShowSeo] = useState(false);
  const [connectedChannels, setConnectedChannels] = useState<ConnectedChannel[]>([]);
  const [copiedItem, setCopiedItem] = useState<'social' | 'web' | null>(null);
  const [publishState, setPublishState] = useState<PublishState>({ status: 'idle' });
  const [savedJobId, setSavedJobId] = useState<number | null>(draftJob?.id ?? null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGenerating = useRef(false);
  // Google post is generated server-side and saved to DB but not surfaced in this UI
  const googlePostRef = useRef('');

  const generate = async () => {
    if (isGenerating.current) return;
    isGenerating.current = true;
    setState({ status: 'loading' });

    // Load channels — prefer server-side (real OAuth connections) when signed in
    let channels: ConnectedChannel[] = [];
    let sessionToken: string | null = null;
    try {
      sessionToken = await getSessionToken();
      if (sessionToken) {
        channels = await fetchServerConnectedChannels(sessionToken, API_URL);
      }
      if (channels.length === 0) channels = await getConnectedChannels();
      setConnectedChannels(channels);
    } catch { /* ignore */ }

    // Only generate content for connected platforms; social post is always included
    const platforms = [
      'social',
      ...(channels.some(ch => ch.platform === 'google')    ? ['google']    : []),
      ...(channels.some(ch => ch.platform === 'wordpress') ? ['wordpress'] : []),
    ];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const classifications = payload.photos.map(p => p.classification);
        const gpsCoords = payload.photos
          .map(p => p.gps)
          .filter((g): g is { lat: number; lng: number } => g != null);

        const profile = await getBusinessProfile();
        const effectiveCategory = profile.category === 'Other' ? profile.categoryCustom : profile.category;

        let data: any;

        const authHeader: Record<string, string> = sessionToken
          ? { Authorization: `Bearer ${sessionToken}` }
          : {};

        if (payload.audioUri) {
          const result = await raceTimeout(FileSystem.uploadAsync(
            `${API_URL}/api/generate`,
            payload.audioUri,
            {
              httpMethod: 'POST',
              uploadType: FileSystem.FileSystemUploadType.MULTIPART,
              fieldName: 'audio',
              mimeType: 'audio/m4a',
              headers: authHeader,
              parameters: {
                photoCount: String(payload.photos.length),
                classifications: JSON.stringify(classifications),
                gpsCoords: JSON.stringify(gpsCoords),
                businessName: profile.name,
                businessWebsite: profile.website,
                businessInquiryUrl: profile.inquiryUrl ?? '',
                businessCategory: effectiveCategory,
                businessDescription: profile.description,
                writingStyle: profile.writingStyle,
                customWritingInstructions: profile.customWritingInstructions,
                businessServices: JSON.stringify(profile.services),
                serviceAreas: JSON.stringify(profile.serviceAreas),
                platforms: JSON.stringify(platforms),
              },
            }
          ));
          if (result.status < 200 || result.status >= 300) {
            throw new Error(`Server error ${result.status}: ${result.body}`);
          }
          data = JSON.parse(result.body);
        } else {
          const response = await raceTimeout(fetch(`${API_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify({
              photoCount: payload.photos.length,
              classifications,
              gpsCoords,
              businessName: profile.name,
              businessWebsite: profile.website,
              businessInquiryUrl: profile.inquiryUrl ?? '',
              businessCategory: effectiveCategory,
              businessDescription: profile.description,
              writingStyle: profile.writingStyle,
              customWritingInstructions: profile.customWritingInstructions,
              businessServices: profile.services,
              serviceAreas: profile.serviceAreas,
              platforms,
            }),
          }));
          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server error ${response.status}: ${text}`);
          }
          data = await response.json();
        }

        // Location resolution: transcription → GPS reverse geocode → business location
        let loc = data.location ? `${data.location.city}, ${data.location.state}` : '';
        if (!loc && profile.location) loc = profile.location;

        setState({
          status: 'success',
          googlePost: data.googlePost ?? '',
          socialPost: data.socialPost ?? '',
          webContent: data.webContent ?? '',
          transcription: data.transcription ?? '',
          location: loc,
          seoMetadata: data.seoMetadata ?? null,
          isMock: data.mock === true,
        });
        googlePostRef.current = data.googlePost ?? '';
        setEditedSocial(data.socialPost ?? '');
        setEditedThreads(truncateForThreads(data.socialPost ?? ''));
        setEditedWordpress(data.webContent ?? '');
        setEditedWordpressTitle(data.seoMetadata?.seoTitle ?? extractMarkdownTitle(data.webContent ?? ''));
        setEditedLocation(loc);

        saveJob({
          audioSourceUri: payload.audioUri,
          transcription: data.transcription ?? '',
          googlePost: googlePostRef.current,
          socialPost: data.socialPost ?? '',
          webContent: data.webContent ?? '',
          location: loc,
          seoMetadata: data.seoMetadata ?? null,
          isMock: data.mock === true,
          photos: payload.photos.map(p => ({ uri: p.uri, classification: p.classification, isFeatured: p.isFeatured ?? false })),
        }).then(jobId => setSavedJobId(jobId)).catch(err => console.warn('DB save failed:', err));

        break; // success — exit retry loop

      } catch (err: unknown) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 2000));
          // continue to next attempt
        } else {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          setState({ status: 'error', message: msg });
        }
      }
    }

    isGenerating.current = false;
  };

  useEffect(() => {
    if (draftJob) {
      // Load from saved draft — no API call needed
      const social = draftJob.socialContent ?? '';
      const web = draftJob.webContent ?? '';
      const loc = draftJob.jobLocation ?? '';
      setState({
        status: 'success',
        googlePost: draftJob.googlePost ?? '',
        socialPost: social,
        webContent: web,
        transcription: '',
        location: loc,
        seoMetadata: null,
        isMock: draftJob.isMock,
      });
      googlePostRef.current = draftJob.googlePost ?? '';
      setEditedSocial(social);
      setEditedThreads(truncateForThreads(social));
      setEditedWordpress(web);
      setEditedWordpressTitle(extractMarkdownTitle(web));
      setEditedLocation(loc);
      // Still need to load channels for publishing
      (async () => {
        try {
          const token = await getSessionToken();
          let channels: ConnectedChannel[] = [];
          if (token) channels = await fetchServerConnectedChannels(token, API_URL);
          if (channels.length === 0) channels = await getConnectedChannels();
          setConnectedChannels(channels);
          if (draftJob?.publishStatus) {
            const newExcluded = new Set<string>();
            for (const ch of channels) {
              const key = `${ch.platform}_${ch.accountId ?? ch.id}`;
              if (draftJob.publishStatus.platforms[key] === 'excluded') newExcluded.add(ch.id);
            }
            setExcludedPlatforms(newExcluded);
          }
        } catch { /* ignore */ }
      })();
    } else {
      generate();
    }
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const togglePlatform = (chId: string) => {
    setExcludedPlatforms(prev => {
      const next = new Set(prev);
      if (next.has(chId)) next.delete(chId); else next.add(chId);
      return next;
    });
  };

  const copyItem = (item: 'social' | 'web') => {
    Clipboard.setStringAsync(item === 'social' ? editedSocial : editedWordpress);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    setCopiedItem(item);
    copiedTimerRef.current = setTimeout(() => setCopiedItem(null), 2000);
  };

  const runFacebookPublish = async (sessionToken: string): Promise<PageResult[]> => {
    const jobId = savedJobId != null ? String(savedJobId) : `tmp_${Date.now()}`;
    const featuredIndex = payload.photos.findIndex(p => p.isFeatured);

    const formData = new FormData();
    formData.append('message', editedSocial);
    formData.append('job_id', jobId);
    formData.append('featured_index', String(Math.max(0, featuredIndex)));
    formData.append('classifications', JSON.stringify(payload.photos.map(p => p.classification)));

    payload.photos.forEach((photo, i) => {
      formData.append(`photo_${i}`, {
        uri: photo.uri,
        type: 'image/jpeg',
        name: `photo_${i}.jpg`,
      } as unknown as Blob);
    });

    // Use XMLHttpRequest — RN's fetch throws "Unsupported FormData part implementation"
    // when FormData contains native file objects ({uri, type, name}), but XHR handles them.
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/facebook/publish`);
      xhr.setRequestHeader('Authorization', `Bearer ${sessionToken}`);
      xhr.timeout = TIMEOUT_MS;
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Request timed out. Check your connection and try again.'));
      xhr.send(formData);
    });

    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { data = {}; }

    if (status === 422 && data.error === 'no_pages_selected') {
      return [{ pageId: 'fb', pageName: 'Facebook', platform: 'facebook', ok: false, error: 'No Facebook pages selected. Go to Settings → Connected Accounts to select pages.' }];
    }
    if (status < 200 || status >= 300) {
      return [{ pageId: 'fb', pageName: 'Facebook', platform: 'facebook', ok: false, error: (data.error as string) ?? `Server error ${status}` }];
    }

    const rawResults = (data.results as Omit<PageResult, 'platform'>[]) ?? [];
    const mapped = rawResults.map(r => ({ ...r, platform: 'facebook' as const }));
    // Surface a reconnect alert if any page reports an invalidated token
    const needsReconnect = mapped.some(r => (r as any).reconnect_required);
    if (needsReconnect) {
      Alert.alert(
        'Facebook needs to reconnect',
        'Your connection has expired or been revoked. Reconnect Facebook in Settings to continue publishing.',
        [
          { text: 'Open Settings', onPress: onShowSettings },
          { text: 'Dismiss', style: 'cancel' },
        ]
      );
    }
    return mapped;
  };

  const runInstagramPublish = async (sessionToken: string): Promise<PageResult> => {
    const jobId = savedJobId != null ? String(savedJobId) : `tmp_${Date.now()}`;
    const featuredIndex = payload.photos.findIndex(p => p.isFeatured);

    const formData = new FormData();
    formData.append('caption', editedSocial);
    formData.append('job_id', jobId);
    formData.append('featured_index', String(Math.max(0, featuredIndex)));
    formData.append('classifications', JSON.stringify(payload.photos.map(p => p.classification)));

    payload.photos.forEach((photo, i) => {
      formData.append(`photo_${i}`, {
        uri: photo.uri,
        type: 'image/jpeg',
        name: `photo_${i}.jpg`,
      } as unknown as Blob);
    });

    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/instagram/publish`);
      xhr.setRequestHeader('Authorization', `Bearer ${sessionToken}`);
      xhr.timeout = TIMEOUT_MS;
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Request timed out. Check your connection and try again.'));
      xhr.send(formData);
    });

    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { data = {}; }

    if (status === 422 && data.error === 'no_instagram_account') {
      return { pageId: 'ig', pageName: 'Instagram', platform: 'instagram', ok: false, error: 'No Instagram account connected. Go to Settings → Connected Accounts.' };
    }
    if (status === 422 && data.error === 'token_expired') {
      return { pageId: 'ig', pageName: 'Instagram', platform: 'instagram', ok: false, error: 'Instagram token expired. Reconnect in Settings.' };
    }
    if (status < 200 || status >= 300) {
      return { pageId: 'ig', pageName: 'Instagram', platform: 'instagram', ok: false, error: (data.error as string) ?? `Server error ${status}` };
    }

    const result = data as { ok: boolean; accountName?: string; postId?: string; postUrl?: string; duplicate?: boolean; error?: string };
    const pageName = result.accountName ?? 'Instagram';
    if (result.ok) {
      return { pageId: 'ig', pageName, platform: 'instagram', ok: true, postId: result.postId, postUrl: result.postUrl, duplicate: result.duplicate };
    }
    return { pageId: 'ig', pageName, platform: 'instagram', ok: false, error: result.error };
  };

  const runThreadsPublish = async (sessionToken: string): Promise<PageResult> => {
    const jobId = savedJobId != null ? String(savedJobId) : `tmp_${Date.now()}`;
    const featuredIndex = payload.photos.findIndex(p => p.isFeatured);

    const formData = new FormData();
    if (editedThreads.length > 500) {
      return { pageId: 'th', pageName: 'Threads', platform: 'threads', ok: false, error: 'Post exceeds 500 character limit. Please shorten the Threads post.' };
    }
    formData.append('text', editedThreads);
    formData.append('job_id', jobId);
    formData.append('featured_index', String(Math.max(0, featuredIndex)));
    formData.append('classifications', JSON.stringify(payload.photos.map(p => p.classification)));

    payload.photos.forEach((photo, i) => {
      formData.append(`photo_${i}`, {
        uri: photo.uri,
        type: 'image/jpeg',
        name: `photo_${i}.jpg`,
      } as unknown as Blob);
    });

    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_URL}/threads/publish`);
      xhr.setRequestHeader('Authorization', `Bearer ${sessionToken}`);
      xhr.timeout = TIMEOUT_MS;
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Request timed out. Check your connection and try again.'));
      xhr.send(formData);
    });

    let data: Record<string, unknown>;
    try { data = JSON.parse(body); } catch { data = {}; }

    if (status === 422 && data.error === 'no_threads_account') {
      return { pageId: 'th', pageName: 'Threads', platform: 'threads', ok: false, error: 'No Threads account connected. Go to Settings → Connected Accounts.' };
    }
    if (status === 422 && data.error === 'token_expired') {
      return { pageId: 'th', pageName: 'Threads', platform: 'threads', ok: false, error: 'Threads token expired. Reconnect in Settings.' };
    }
    if (status < 200 || status >= 300) {
      return { pageId: 'th', pageName: 'Threads', platform: 'threads', ok: false, error: (data.error as string) ?? `Server error ${status}` };
    }

    const result = data as { ok: boolean; accountName?: string; postId?: string; postUrl?: string; duplicate?: boolean; error?: string; reconnect_required?: boolean };
    const pageName = result.accountName ?? 'Threads';
    if (result.ok) {
      return { pageId: 'th', pageName, platform: 'threads', ok: true, postId: result.postId, postUrl: result.postUrl, duplicate: result.duplicate };
    }
    if (result.reconnect_required) {
      Alert.alert(
        'Threads needs to reconnect',
        'Your Threads connection has expired or been revoked. Reconnect in Settings to continue publishing.',
        [
          { text: 'Open Settings', onPress: onShowSettings },
          { text: 'Dismiss', style: 'cancel' },
        ]
      );
    }
    return { pageId: 'th', pageName, platform: 'threads', ok: false, error: result.error };
  };

  const runWordpressPublish = async (sessionToken: string, wpChannels: ConnectedChannel[]): Promise<PageResult[]> => {
    const jobId        = savedJobId != null ? String(savedJobId) : `tmp_${Date.now()}`;
    const featuredIndex = payload.photos.findIndex(p => p.isFeatured);
    const seoState     = state.status === 'success' ? state.seoMetadata : null;

    const results: PageResult[] = [];
    for (const ch of wpChannels) {
      const wpSiteId = ch.id;
      const formData = new FormData();
      formData.append('title',       editedWordpressTitle || extractMarkdownTitle(editedWordpress) || 'New Post');
      formData.append('content',     editedWordpress);
      formData.append('job_id',      jobId);
      formData.append('wp_site_id',  wpSiteId);
      formData.append('featured_index', String(Math.max(0, featuredIndex)));
      formData.append('classifications', JSON.stringify(payload.photos.map(p => p.classification)));
      if (seoState?.urlSlug)          formData.append('seo_slug',    seoState.urlSlug);
      if (seoState?.metaDescription)  formData.append('seo_excerpt', seoState.metaDescription);

      payload.photos.forEach((photo, i) => {
        formData.append(`photo_${i}`, {
          uri:  photo.uri,
          type: 'image/jpeg',
          name: `photo_${i}.jpg`,
        } as unknown as Blob);
      });

      try {
        const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${API_URL}/wordpress/publish`);
          xhr.setRequestHeader('Authorization', `Bearer ${sessionToken}`);
          xhr.timeout = TIMEOUT_MS;
          xhr.onload  = () => resolve({ status: xhr.status, body: xhr.responseText });
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.ontimeout = () => reject(new Error('Request timed out. Check your connection and try again.'));
          xhr.send(formData);
        });

        let data: Record<string, unknown>;
        try { data = JSON.parse(body); } catch { data = {}; }

        if (status === 422 && data.error === 'no_wordpress_site') {
          results.push({ pageId: `wp_${wpSiteId}`, pageName: ch.accountName, platform: 'wordpress', ok: false, error: 'WordPress site not connected. Go to Settings → Connected Accounts.' });
          continue;
        }
        if (status < 200 || status >= 300) {
          results.push({ pageId: `wp_${wpSiteId}`, pageName: ch.accountName, platform: 'wordpress', ok: false, error: (data.error as string) ?? `Server error ${status}` });
          continue;
        }

        const result = data as { ok: boolean; siteName?: string; postId?: string; postUrl?: string; duplicate?: boolean; error?: string };
        const pageName = result.siteName ?? ch.accountName;
        if (result.ok) {
          results.push({ pageId: `wp_${wpSiteId}`, pageName, platform: 'wordpress', ok: true, postId: result.postId, postUrl: result.postUrl, duplicate: result.duplicate });
        } else {
          results.push({ pageId: `wp_${wpSiteId}`, pageName, platform: 'wordpress', ok: false, error: result.error });
        }
      } catch (err) {
        results.push({ pageId: `wp_${wpSiteId}`, pageName: ch.accountName, platform: 'wordpress', ok: false, error: err instanceof Error ? err.message : 'Publishing failed' });
      }
    }
    return results;
  };

  const handlePostEverywhere = async () => {
    if (connectedChannels.length === 0) {
      Alert.alert(
        'No channels connected',
        'Connect your publishing accounts in Settings to post directly from Elmer.',
        [
          { text: 'Open Settings', onPress: onShowSettings },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    const token = await getSessionToken();
    if (!token) {
      Alert.alert(
        'Sign in required',
        'Sign in to your Elmer account in Settings to publish.',
        [
          { text: 'Open Settings', onPress: onShowSettings },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    const activeChannels = connectedChannels.filter(ch => !excludedPlatforms.has(ch.id));
    if (activeChannels.length === 0) {
      Alert.alert('No platforms selected', 'Check at least one platform in "Where Elmer will post" to publish.');
      return;
    }
    const hasFacebook  = activeChannels.some(ch => ch.platform === 'facebook');
    const hasInstagram = activeChannels.some(ch => ch.platform === 'instagram');
    const hasThreads   = activeChannels.some(ch => ch.platform === 'threads');
    const wpChannels   = activeChannels.filter(ch => ch.platform === 'wordpress');
    const channelList  = activeChannels.map(ch => ch.accountName).join(', ');

    Alert.alert(
      'Publish?',
      `Post to: ${channelList}`,
      [
        { text: 'Post', onPress: async () => {
          setPublishState({ status: 'publishing' });
          try {
            const tasks: Promise<PageResult[]>[] = [];
            if (hasFacebook)         tasks.push(runFacebookPublish(token));
            if (hasInstagram)        tasks.push(runInstagramPublish(token).then(r => [r]));
            if (hasThreads)          tasks.push(runThreadsPublish(token).then(r => [r]));
            if (wpChannels.length)   tasks.push(runWordpressPublish(token, wpChannels));

            const settled = await Promise.allSettled(tasks);
            const allResults: PageResult[] = [];
            for (const s of settled) {
              if (s.status === 'fulfilled') {
                allResults.push(...s.value);
              } else {
                allResults.push({ pageId: 'unknown', pageName: 'Unknown', platform: 'unknown', ok: false, error: s.reason?.message ?? 'Publishing failed' });
              }
            }
            setPublishState({ status: 'success', results: allResults });

            if (savedJobId != null) {
              const platformsRecord: Record<string, JobPlatformResult> = {};
              for (const chId of excludedPlatforms) {
                const ch = connectedChannels.find(c => c.id === chId);
                if (ch) platformsRecord[`${ch.platform}_${ch.accountId ?? ch.id}`] = 'excluded';
              }
              for (const r of allResults) {
                platformsRecord[getResultKey(r, connectedChannels)] = r.ok ? 'success' : 'failed';
              }
              const successes = allResults.filter(r => r.ok).length;
              const failures  = allResults.filter(r => !r.ok).length;
              const newStatus = successes > 0 && failures === 0 ? 'published' : successes > 0 ? 'partial' : 'failed';
              updateJobPublishStatus(savedJobId, newStatus, {
                platforms: platformsRecord,
                results: allResults.map(r => ({ platform: r.platform, pageName: r.pageName, ok: r.ok, postUrl: r.postUrl, error: r.error, duplicate: r.duplicate })),
              }).catch(() => {});
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Publishing failed';
            setPublishState({ status: 'error', message: msg });
          }
        }},
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const wordCount = (text: string) =>
    text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

  const hasConnections = connectedChannels.length > 0;
  const hasWordpress = connectedChannels.some(ch => ch.platform === 'wordpress');
  const threadsChannel = connectedChannels.find(ch => ch.platform === 'threads');

  // Full-screen confirmation after a successful publish
  if (publishState.status === 'success') {
    const anyOk = publishState.results.some(r => r.ok);
    return (
      <View style={styles.container}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.confirmedContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.confirmedEmoji}>{anyOk ? '🎉' : '⚠️'}</Text>
          <Text style={styles.confirmedHeading}>
            {anyOk ? 'Your post was published!' : 'Publishing finished'}
          </Text>
          <Text style={styles.confirmedSub}>
            {anyOk ? "That was easy." : 'Some posts could not be published.'}
          </Text>

          <View style={styles.confirmedButtons}>
            {publishState.results.map((r, i) => {
              const cfg = PLATFORM_CFG[r.platform] ?? PLATFORM_CFG.default;
              const canOpen = r.ok && !!r.postUrl;
              const btnBg = r.ok ? cfg.bg : '#2A3347';
              const iconColor = r.ok ? cfg.iconColor : colors.textMuted;
              return (
                <TouchableOpacity
                  key={i}
                  style={[
                    styles.viewOnBtn,
                    { backgroundColor: btnBg },
                    !canOpen && styles.viewOnBtnDim,
                  ]}
                  onPress={() => canOpen && Linking.openURL(r.postUrl!)}
                  activeOpacity={canOpen ? 0.8 : 1}
                >
                  <Ionicons name={cfg.icon as any} size={20} color={iconColor} />
                  <View style={styles.viewOnBtnText}>
                    <Text style={[styles.viewOnLabel, { color: r.ok ? cfg.iconColor : undefined }, !r.ok && styles.viewOnLabelDim]}>
                      {r.ok
                        ? (r.duplicate ? `Already posted · ${platformDisplayName(r.platform)}` : `View on ${platformDisplayName(r.platform)}`)
                        : `Failed · ${platformDisplayName(r.platform)}`}
                    </Text>
                    {platformDisplayName(r.platform) !== r.pageName && (
                      <Text style={[styles.viewOnPageName, r.ok && { color: cfg.iconColor, opacity: 0.55 }]}>{r.pageName}</Text>
                    )}
                    {!r.ok && r.error && (
                      <Text style={styles.viewOnError} numberOfLines={1}>{r.error}</Text>
                    )}
                  </View>
                  {canOpen && (
                    <Ionicons name="open-outline" size={14} color={r.ok ? cfg.iconColor : colors.textMuted} style={styles.viewOnExternal} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={styles.confirmedDoneBtn}
            onPress={() => { onPublishComplete?.(); onBack(); }}
            activeOpacity={0.8}
          >
            <Text style={styles.confirmedDoneBtnText}>Done</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={onBack}
          style={styles.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Ready to post!</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Loading */}
        {state.status === 'loading' && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.cyan} />
            <Text style={styles.loadingText}>Generating your content…</Text>
            <Text style={styles.loadingSubtext}>
              Transcribing your recording and writing your post.{'\n'}This usually takes about 15 seconds.
            </Text>
          </View>
        )}

        {/* Error */}
        {state.status === 'error' && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorIcon}>⚠️</Text>
            <Text style={styles.errorTitle}>Something went wrong</Text>
            <Text style={styles.errorMessage}>{state.message}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={generate} activeOpacity={0.8}>
              <Text style={styles.retryBtnText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Success */}
        {state.status === 'success' && (
          <>
            {state.isMock && (
              <View style={styles.mockBanner}>
                <Text style={styles.mockBannerText}>
                  MOCK — Set OPENAI_API_KEY in server/.env for real AI generation.
                </Text>
              </View>
            )}

            {/* Job summary: photos + location */}
            <View style={styles.summaryCard}>
              {payload.photos.length > 0 && (
                <View style={styles.photoStrip}>
                  {payload.photos.map((photo, i) => (
                    <View key={i} style={styles.photoThumb}>
                      <Image source={{ uri: photo.uri }} style={styles.photoImg} />
                      <View style={[styles.photoBadge, { backgroundColor: BADGE_COLORS[photo.classification] }]}>
                        <Text style={styles.photoBadgeText}>{photo.classification}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
              <View style={[styles.locationRow, payload.photos.length > 0 && styles.locationRowBorder]}>
                <Text style={styles.locationLabel}>Location</Text>
                <TextInput
                  style={styles.locationInput}
                  value={editedLocation}
                  onChangeText={setEditedLocation}
                  placeholder="City, State"
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  returnKeyType="done"
                />
                {!editedLocation && (
                  <Text style={styles.locationNotDetected}>Not detected</Text>
                )}
              </View>
            </View>

            {/* Primary post */}
            <View style={styles.postCard}>
              <View style={styles.postCardHeader}>
                <Text style={styles.cardLabel}>Your post</Text>
                <Text style={styles.editHint}>Tap to edit</Text>
              </View>
              <TextInput
                style={styles.postInput}
                value={editedSocial}
                onChangeText={setEditedSocial}
                multiline
                textAlignVertical="top"
                autoCorrect
                scrollEnabled={false}
              />
              <View style={styles.postCardFooter}>
                <Text style={styles.metaCount}>{editedSocial.length} characters</Text>
                <TouchableOpacity
                  onPress={() => copyItem('social')}
                  hitSlop={{ top: 8, bottom: 8, left: 12, right: 4 }}
                >
                  <Text style={styles.copyInline}>
                    {copiedItem === 'social' ? '✓ Copied!' : 'Copy'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Where Elmer will post */}
            <View style={styles.destinationsCard}>
              <Text style={styles.destinationsTitle}>Where Elmer will post</Text>

              {hasConnections ? (
                connectedChannels.map((ch, i) => {
                  const isExcluded = excludedPlatforms.has(ch.id);
                  return (
                    <View key={ch.id}>
                      {i > 0 && <View style={styles.divider} />}
                      <TouchableOpacity
                        style={styles.destinationRow}
                        onPress={() => togglePlatform(ch.id)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.destinationLeft}>
                          <View style={[styles.destinationDot, isExcluded && styles.destinationDotDim]} />
                          <View>
                            <Text style={[styles.destinationName, isExcluded && styles.destinationNameDim]}>
                              {platformLabel(ch.platform)}
                            </Text>
                            <Text style={styles.destinationSub}>{ch.accountName}</Text>
                          </View>
                        </View>
                        <View style={[styles.destinationCheckbox, !isExcluded && styles.destinationCheckboxChecked]}>
                          {!isExcluded && <Ionicons name="checkmark" size={13} color={colors.bg} />}
                        </View>
                      </TouchableOpacity>
                    </View>
                  );
                })
              ) : (
                <View style={styles.noChannels}>
                  <Text style={styles.noChannelsText}>No channels connected yet.</Text>
                  <TouchableOpacity
                    style={styles.connectBtn}
                    onPress={onShowSettings}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.connectBtnText}>Connect Channels</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            {/* Platform variations — Threads (500 chars) and/or WordPress, collapsed by default */}
            {(threadsChannel || hasWordpress) && (
              <View style={styles.articleCard}>
                <TouchableOpacity
                  style={styles.articleHeader}
                  onPress={() => setShowVariations(v => !v)}
                  activeOpacity={0.8}
                >
                  <View>
                    <Text style={styles.cardLabel}>Platform variations</Text>
                    <Text style={styles.articleMeta}>
                      {[threadsChannel && 'Threads', hasWordpress && 'WordPress'].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  <Text style={styles.previewToggle}>
                    {showVariations ? 'Hide ▲' : 'Edit ▼'}
                  </Text>
                </TouchableOpacity>

                {showVariations && (
                  <View style={styles.articleBody}>
                    {threadsChannel && (
                      <>
                        <Text style={styles.variationLabel}>Threads · 500 char limit</Text>
                        <TextInput
                          style={styles.webInput}
                          value={editedThreads}
                          onChangeText={text => setEditedThreads(text.slice(0, 500))}
                          multiline
                          textAlignVertical="top"
                          autoCorrect
                          scrollEnabled={false}
                        />
                        <View style={styles.postCardFooter}>
                          <Text style={[styles.metaCount, editedThreads.length > 450 && styles.threadsCountWarn]}>
                            {editedThreads.length}/500
                          </Text>
                        </View>
                      </>
                    )}

                    {threadsChannel && hasWordpress && (
                      <View style={[styles.divider, { marginHorizontal: 0, marginVertical: 16 }]} />
                    )}

                    {hasWordpress && (
                      <>
                        <Text style={styles.variationLabel}>WordPress article</Text>
                        <TextInput
                          style={styles.wpTitleInput}
                          value={editedWordpressTitle}
                          onChangeText={setEditedWordpressTitle}
                          placeholder="Article title"
                          placeholderTextColor={colors.textMuted}
                          autoCorrect
                          returnKeyType="next"
                        />
                        <TextInput
                          style={styles.webInput}
                          value={editedWordpress}
                          onChangeText={setEditedWordpress}
                          multiline
                          textAlignVertical="top"
                          autoCorrect
                          scrollEnabled={false}
                        />
                        <View style={styles.postCardFooter}>
                          <Text style={styles.metaCount}>{wordCount(editedWordpress)} words</Text>
                          <TouchableOpacity
                            onPress={() => copyItem('web')}
                            hitSlop={{ top: 8, bottom: 8, left: 12, right: 4 }}
                          >
                            <Text style={styles.copyInline}>
                              {copiedItem === 'web' ? '✓ Copied!' : 'Copy Article'}
                            </Text>
                          </TouchableOpacity>
                        </View>

                        {state.seoMetadata && (
                          <View style={styles.seoCard}>
                            <TouchableOpacity
                              style={styles.seoHeader}
                              onPress={() => setShowSeo(v => !v)}
                              activeOpacity={0.8}
                            >
                              <Text style={styles.seoHeaderTitle}>SEO Details</Text>
                              <Text style={styles.seoHeaderChevron}>{showSeo ? '▲' : '▼'}</Text>
                            </TouchableOpacity>
                            {showSeo && (
                              <View style={styles.seoBody}>
                                <SeoRow label="SEO Title" value={state.seoMetadata.seoTitle} />
                                <SeoRow label="URL Slug" value={`/${state.seoMetadata.urlSlug}`} mono />
                                <SeoRow label="Meta Description" value={state.seoMetadata.metaDescription} />
                                <SeoRow label="Main Keyword" value={state.seoMetadata.mainKeyword} />
                                <Text style={styles.seoFieldLabel}>Secondary Keywords</Text>
                                <View style={styles.tagRow}>
                                  {state.seoMetadata.secondaryKeywords.map((kw, i) => (
                                    <View key={i} style={styles.tag}>
                                      <Text style={styles.tagText}>{kw}</Text>
                                    </View>
                                  ))}
                                </View>
                                {state.seoMetadata.imageFilenames.length > 0 && (
                                  <>
                                    <Text style={[styles.seoFieldLabel, { marginTop: 12 }]}>Image Filenames</Text>
                                    {state.seoMetadata.imageFilenames.map((fn, i) => (
                                      <View key={i} style={styles.imageRow}>
                                        <Text style={styles.imageFilename}>{fn}</Text>
                                        {state.seoMetadata!.imageAltTexts[i] && (
                                          <Text style={styles.imageAlt}>
                                            Alt: {state.seoMetadata!.imageAltTexts[i]}
                                          </Text>
                                        )}
                                      </View>
                                    ))}
                                  </>
                                )}
                              </View>
                            )}
                          </View>
                        )}
                      </>
                    )}
                  </View>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Footer */}
      {state.status === 'success' && (
        <View style={styles.footer}>
          {/* Publish status feedback */}
          {publishState.status === 'publishing' && (
            <View style={styles.publishingBanner}>
              <ActivityIndicator color={colors.cyan} size="small" />
              <Text style={styles.publishingText}>Publishing…</Text>
            </View>
          )}
          {publishState.status === 'error' && (
            <View style={styles.publishErrorBanner}>
              <Text style={styles.publishErrorText}>{publishState.message}</Text>
              <TouchableOpacity onPress={() => setPublishState({ status: 'idle' })} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.publishErrorDismiss}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          )}

          <TouchableOpacity
            style={[
              styles.postEverywhereBtn,
              (!hasConnections || publishState.status === 'publishing') && styles.postEverywhereBtnDim,
            ]}
            onPress={handlePostEverywhere}
            disabled={publishState.status === 'publishing'}
            activeOpacity={0.8}
          >
            <Text style={styles.postEverywhereBtnText}>Post Everywhere</Text>
            {!hasConnections && (
              <Text style={styles.postEverywhereSubtext}>Connect channels in Settings</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.regenBtn} onPress={generate} activeOpacity={0.8}>
            <Text style={styles.regenBtnText}>Regenerate</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const PLATFORM_CFG: Record<string, { bg: string; iconColor: string; icon: string }> = {
  facebook:  { bg: '#1877F2', iconColor: '#fff',          icon: 'logo-facebook' },
  google:    { bg: colors.cyan, iconColor: colors.bg,     icon: 'logo-google' },
  wordpress: { bg: '#3D454E', iconColor: '#A0AEC0',       icon: 'globe-outline' },
  instagram: { bg: '#C13584', iconColor: '#fff',          icon: 'logo-instagram' },
  threads:   { bg: '#fff',    iconColor: '#101010',        icon: 'logo-threads'   },
  twitter:   { bg: '#1DA1F2', iconColor: '#fff',          icon: 'logo-twitter' },
  default:   { bg: colors.surface, iconColor: colors.cyan, icon: 'globe-outline' },
};

function truncateForThreads(text: string): string {
  if (text.length <= 500) return text;
  const cut = text.slice(0, 497);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 400 ? cut.slice(0, lastSpace) : cut) + '...';
}

function platformDisplayName(platform: string): string {
  const names: Record<string, string> = {
    facebook: 'Facebook',
    instagram: 'Instagram',
    threads: 'Threads',
    google: 'Google Business',
    wordpress: 'WordPress',
    twitter: 'X',
  };
  return names[platform] ?? platform;
}

function getResultKey(r: PageResult, channels: ConnectedChannel[]): string {
  if (r.platform === 'facebook') return `facebook_${r.pageId}`;
  const ch = channels.find(c => c.platform === r.platform);
  return ch ? `${ch.platform}_${ch.accountId ?? ch.id}` : `${r.platform}_${r.pageId}`;
}

function platformLabel(platform: ConnectedChannel['platform']): string {
  const labels: Record<ConnectedChannel['platform'], string> = {
    google: 'Google Business Profile',
    facebook: 'Facebook Pages',
    instagram: 'Instagram',
    threads: 'Threads',
    twitter: 'X (Twitter)',
    wordpress: 'WordPress',
  };
  return labels[platform];
}

function SeoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={seoRowStyles.container}>
      <Text style={seoRowStyles.label}>{label}</Text>
      <Text style={[seoRowStyles.value, mono && seoRowStyles.mono]}>{value}</Text>
    </View>
  );
}

const seoRowStyles = StyleSheet.create({
  container: { marginBottom: 10 },
  label: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  value: { fontSize: 14, color: colors.textPrimary, lineHeight: 20 },
  mono: { fontFamily: 'Courier', fontSize: 13, color: colors.cyan },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  header: {
    backgroundColor: colors.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: { width: 80 },
  backBtnText: { color: colors.cyan, fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  headerTitle: { fontSize: 20, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary },

  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 32 },

  loadingContainer: { marginTop: 60, alignItems: 'center' },
  loadingText: { marginTop: 20, fontSize: 20, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary },
  loadingSubtext: { marginTop: 8, fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  errorContainer: { marginTop: 40, alignItems: 'center', paddingHorizontal: 20 },
  errorIcon: { fontSize: 48, marginBottom: 16 },
  errorTitle: { fontSize: 22, fontFamily: 'DMSans_600SemiBold', color: colors.error, marginBottom: 10 },
  errorMessage: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 28, lineHeight: 20 },
  retryBtn: { backgroundColor: colors.cyan, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 40 },
  retryBtnText: { color: colors.bg, fontSize: 17, fontFamily: 'Inter_600SemiBold' },

  mockBanner: {
    backgroundColor: 'rgba(200,160,40,0.12)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(200,160,40,0.25)',
  },
  mockBannerText: { fontSize: 13, color: '#C8A040', lineHeight: 18, fontWeight: '500' },

  // Job summary card
  summaryCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 12,
    paddingBottom: 10,
  },
  photoThumb: { position: 'relative' },
  photoImg: { width: 68, height: 68, borderRadius: 8 },
  photoBadge: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    paddingVertical: 2,
    alignItems: 'center',
  },
  photoBadgeText: { fontSize: 9, fontWeight: '700', color: '#fff', letterSpacing: 0.3 },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  locationRowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  locationLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  locationInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    padding: 0,
  },
  locationNotDetected: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic' },

  // Primary post card
  postCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  postCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  editHint: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  postInput: {
    fontSize: 15,
    color: colors.textPrimary,
    lineHeight: 23,
    minHeight: 150,
    padding: 0,
  },
  postCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  metaCount: { fontSize: 11, color: colors.textMuted },
  copyInline: { fontSize: 13, fontWeight: '700', color: colors.cyan },

  // Destinations card
  destinationsCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    paddingBottom: 4,
  },
  destinationsTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  destinationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  destinationName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 2 },
  destinationSub: { fontSize: 12, color: colors.textMuted },
  connectedChip: {
    backgroundColor: 'rgba(82,214,164,0.15)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  connectedChipText: { fontSize: 11, fontWeight: '700', color: colors.success },
  destinationLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  destinationDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  destinationDotDim: { backgroundColor: colors.textMuted },
  destinationNameDim: { color: colors.textMuted },
  destinationCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  destinationCheckboxChecked: { backgroundColor: colors.success, borderColor: colors.success },
  threadsCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  threadsCountWarn: { color: '#C87A20' },
  variationLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
  },
  viewOnPageName: { fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 1 },
  noChannels: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 12,
  },
  noChannelsText: { fontSize: 14, color: colors.textSecondary },
  connectBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 28,
  },
  connectBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.bg },
  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: 16 },

  // Website article card
  articleCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  articleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  articleMeta: { fontSize: 12, color: colors.textMuted, marginTop: 3 },
  previewToggle: { fontSize: 13, fontWeight: '700', color: colors.cyan },
  articleBody: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: 16,
  },
  webInput: {
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 22,
    minHeight: 200,
    padding: 0,
  },

  wpTitleInput: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 10,
    marginBottom: 12,
    padding: 0,
  },

  // SEO card
  seoCard: {
    backgroundColor: colors.bg,
    borderRadius: 10,
    overflow: 'hidden',
    marginTop: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  seoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  seoHeaderTitle: { fontSize: 13, fontFamily: 'DMSans_600SemiBold', color: colors.textPrimary },
  seoHeaderChevron: { fontSize: 11, color: colors.textMuted },
  seoBody: {
    paddingHorizontal: 12,
    paddingBottom: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
  },
  seoFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    backgroundColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  tagText: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  imageRow: { marginBottom: 8 },
  imageFilename: { fontSize: 13, fontFamily: 'Courier', color: colors.cyan },
  imageAlt: { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },

  // Footer
  footer: {
    padding: 16,
    paddingBottom: 20,
    gap: 10,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  publishingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(82,214,164,0.08)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(82,214,164,0.2)',
  },
  publishingText: { fontSize: 14, color: colors.success, fontWeight: '500' },

  publishSuccessBanner: {
    backgroundColor: 'rgba(82,214,164,0.08)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(82,214,164,0.2)',
  },
  publishResultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 6,
  },
  publishResultBorder: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(82,214,164,0.2)',
  },
  publishResultIcon: { fontSize: 14, fontWeight: '700', color: colors.success, lineHeight: 20 },
  publishResultIconError: { color: colors.error },
  publishResultInfo: { flex: 1 },
  publishResultName: { fontSize: 14, fontWeight: '600', color: colors.success },
  publishResultNameError: { color: colors.error },
  publishResultSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  publishResultSubError: { fontSize: 11, color: colors.error, marginTop: 2, opacity: 0.8 },

  publishErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,80,80,0.08)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,80,80,0.25)',
  },
  publishErrorText: { flex: 1, fontSize: 13, color: colors.error, lineHeight: 18 },
  publishErrorDismiss: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  postEverywhereBtn: {
    backgroundColor: colors.cyan,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
  },
  postEverywhereBtnDim: { opacity: 0.4 },
  postEverywhereBtnText: { color: colors.bg, fontSize: 19, fontFamily: 'Inter_600SemiBold' },
  postEverywhereSubtext: { color: colors.bg, fontSize: 12, fontWeight: '500', marginTop: 3, opacity: 0.7 },
  regenBtn: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    alignItems: 'center',
  },
  regenBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: colors.textSecondary },

  // Published confirmation screen
  confirmedContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 48,
  },
  confirmedEmoji: { fontSize: 56, marginBottom: 20 },
  confirmedHeading: {
    fontSize: 28,
    fontFamily: 'DMSans_700Bold',
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: 8,
  },
  confirmedSub: {
    fontSize: 17,
    fontFamily: 'Inter_400Regular',
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 40,
  },
  confirmedButtons: { width: '100%', gap: 12, marginBottom: 32 },
  viewOnBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 20,
    gap: 12,
  },
  viewOnBtnDim: { opacity: 0.55 },
  viewOnBtnSkipped: { borderWidth: 1, borderColor: colors.border },
  viewOnBtnText: { flex: 1 },
  viewOnLabel: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: '#fff' },
  viewOnLabelDim: { color: colors.textMuted },
  viewOnError: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  viewOnExternal: { opacity: 0.7 },
  confirmedDoneBtn: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  confirmedDoneBtnText: { fontSize: 16, fontFamily: 'Inter_600SemiBold', color: colors.textSecondary },
});
