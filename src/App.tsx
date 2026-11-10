import { useState, useEffect, useRef } from 'react';
import {
  Activity,
  Users,
  ShoppingBag,
  Settings,
  Power,
  Camera,
  AlertTriangle,
  RefreshCw,
  LogOut,
  Skull,
  Bell,
  Clock,
  Terminal,
  ClipboardPaste,
  Check,
  Radio,
} from 'lucide-react';
import { RemoteBridge } from './remoteBridge';
import { ALL_VALORANT_AGENTS } from './data/agents';
import type {
  MobileClientStatus,
  LiveMatchRoster,
  TrackedPlayer,
  StorefrontData,
  RemoteNotification,
  RemoteMessage,
  PregameState,
  AgentInfo,
} from './types';
import './App.css';

interface NotifPreferences {
  disconnect: boolean;
  status: boolean;
  rank: boolean;
}

const getOrCreateClientId = (): string => {
  let id = localStorage.getItem('sagebot_client_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    localStorage.setItem('sagebot_client_id', id);
  }
  return id;
};

const getDeviceDefaultName = (): string => {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android Device';
  return 'Mobile Browser';
};

const formatCountdownDHMS = (totalSecs?: number): string => {
  if (!totalSecs || totalSecs <= 0) return '00:00:00:00';
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = Math.floor(totalSecs % 60);
  return `${days.toString().padStart(2, '0')}:${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const getPartyClass = (tag?: string): string => {
  if (!tag) return '';
  return `party-${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
};

const getRankColor = (rankName?: string): string => {
  if (!rankName) return '#94a3b8';
  const r = rankName.toLowerCase();
  if (r.includes('radiant')) return '#fef08a';
  if (r.includes('immortal')) return '#f43f5e';
  if (r.includes('ascendant')) return '#34d399';
  if (r.includes('diamond')) return '#c084fc';
  if (r.includes('platinum')) return '#22d3ee';
  if (r.includes('gold')) return '#fbbf24';
  if (r.includes('silver')) return '#cbd5e1';
  if (r.includes('bronze')) return '#b45309';
  if (r.includes('iron')) return '#94a3b8';
  return '#94a3b8';
};

export function App() {
  const [roomCode, setRoomCode] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken && urlToken.trim().length >= 16) {
      localStorage.setItem('sagebot_secret_token', urlToken.trim());
    }
    const urlRoom = params.get('room');
    if (urlRoom && urlRoom.trim().length >= 4) {
      const clean = urlRoom.trim().toUpperCase();
      localStorage.setItem('sagebot_room_code', clean);
      return clean;
    }
    return localStorage.getItem('sagebot_room_code') || '';
  });

  const [pinInput, setPinInput] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const urlRoom = params.get('room');
    if (urlRoom && urlRoom.trim().length >= 4) {
      return urlRoom.trim().toUpperCase();
    }
    return localStorage.getItem('sagebot_room_code') || '';
  });

  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isPendingApproval, setIsPendingApproval] = useState<boolean>(false);
  const [connectionError, setConnectionError] = useState<string>('');

  // Exactly 4 primary footer tabs: 'status' | 'tracker' | 'shop' | 'settings'
  const [activeTab, setActiveTab] = useState<'status' | 'tracker' | 'shop' | 'settings'>('status');

  // Status & live data verified from PC
  const [status, setStatus] = useState<MobileClientStatus | null>(null);
  const [botRunning, setBotRunning] = useState<boolean>(false);
  const [roster, setRoster] = useState<LiveMatchRoster | null>(null);
  const [storefront, setStorefront] = useState<StorefrontData | null>(null);
  const [dailySeconds, setDailySeconds] = useState<number>(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState<boolean>(false);

  // Agent Select & Pregame state
  const [pregame, setPregame] = useState<PregameState | null>(null);
  const [selectedRoleFilter, setSelectedRoleFilter] = useState<string>('ALL');
  const [pendingAgentLock, setPendingAgentLock] = useState<AgentInfo | null>(null);
  const [isLocking, setIsLocking] = useState<boolean>(false);
  const [showMatchWarningModal, setShowMatchWarningModal] = useState<boolean>(false);
  const [manualAgentSelectActive, setManualAgentSelectActive] = useState<boolean>(false);
  const handledPregameMatchIdRef = useRef<string>('');

  // Notifications & Modals
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [incomingNotification, setIncomingNotification] = useState<RemoteNotification | null>(null);
  const [showKillConfirm, setShowKillConfirm] = useState<boolean>(false);
  const [hasNotifPermission, setHasNotifPermission] = useState<boolean>(() => {
    return typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted';
  });

  // Notification Preferences
  const [notifPrefs, setNotifPrefs] = useState<NotifPreferences>(() => {
    try {
      const raw = localStorage.getItem('sagebot_notif_prefs');
      if (raw) return JSON.parse(raw);
    } catch {
      // fallback
    }
    return { disconnect: true, status: true, rank: true };
  });

  const bridgeRef = useRef<RemoteBridge | null>(null);
  const connectedRef = useRef<boolean>(false);
  const handshakeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handshakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHandshakeTimers = () => {
    if (handshakeIntervalRef.current) {
      clearInterval(handshakeIntervalRef.current);
      handshakeIntervalRef.current = null;
    }
    if (handshakeTimeoutRef.current) {
      clearTimeout(handshakeTimeoutRef.current);
      handshakeTimeoutRef.current = null;
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 2800);
  };

  const updateNotifPref = (key: keyof NotifPreferences, val: boolean) => {
    setNotifPrefs((prev) => {
      const updated = { ...prev, [key]: val };
      localStorage.setItem('sagebot_notif_prefs', JSON.stringify(updated));
      return updated;
    });
  };

  // Local 1-second ticking countdown for daily offers
  useEffect(() => {
    if (dailySeconds <= 0) return;
    const timer = setInterval(() => {
      setDailySeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [dailySeconds]);

  // Trigger Native OS push notification (strictly titled "SageBot")
  const triggerNativeNotification = (body: string, tag: string) => {
    const cleanTitle = 'SageBot';

    // 1. Send to Service Worker for background system lockscreen notification
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SHOW_NOTIFICATION',
        title: cleanTitle,
        body,
        tag,
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(cleanTitle, {
          body,
          icon: '/sage.ico',
          tag,
        });
      } catch {
        // ignore
      }
    }

    // 2. Mobile vibration feedback
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate([150, 80, 150]);
      } catch {
        // ignore
      }
    }
  };

  const handleIncomingNotification = (notif: RemoteNotification) => {
    // Check preferences
    const eventType = notif.eventType || '';
    if (eventType.includes('disconnect') && !notifPrefs.disconnect) return;
    if ((eventType.includes('status') || eventType.includes('match') || eventType.includes('ready')) && !notifPrefs.status) return;
    if (eventType.includes('rank') && !notifPrefs.rank) return;

    const cleanNotif: RemoteNotification = {
      ...notif,
      title: 'SageBot',
    };
    setIncomingNotification(cleanNotif);
    triggerNativeNotification(notif.message, notif.eventType);

    setTimeout(() => {
      setIncomingNotification((prev) => (prev?.timestamp === notif.timestamp ? null : prev));
    }, 5500);
  };

  // Connect to PC over Dual-Broker WSS Bridge with 8-character code + Pair Approval
  const connectToPC = (targetRoom: string) => {
    const cleanRoom = targetRoom.trim().toUpperCase();
    if (!cleanRoom || cleanRoom.length < 4) {
      setConnectionError('Please enter your 8-character pairing code');
      return;
    }

    // Request notification permission smoothly upon connection
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        setHasNotifPermission(perm === 'granted');
      }).catch(() => { });
    }

    setRoomCode(cleanRoom);
    setPinInput(cleanRoom);
    setIsConnecting(true);
    setIsPendingApproval(false);
    setConnectionError('');
    connectedRef.current = false;
    clearHandshakeTimers();

    if (bridgeRef.current) {
      bridgeRef.current.destroy();
      bridgeRef.current = null;
    }

    const clientId = getOrCreateClientId();
    const storedToken = localStorage.getItem('sagebot_secret_token') || undefined;
    const proposedName = getDeviceDefaultName();

    let approvalReceived = false;

    const sendPairRequest = (b: RemoteBridge) => {
      if (connectedRef.current || approvalReceived) return;
      b.send({
        type: 'verify_pair',
        client_id: clientId,
        code: cleanRoom,
        token: storedToken,
        proposed_name: proposedName,
      });
    };

    const bridge = new RemoteBridge(cleanRoom, 'mobile', {
      onBrokerReady: () => {
        sendPairRequest(bridge);
        if (!handshakeIntervalRef.current) {
          handshakeIntervalRef.current = setInterval(() => {
            if (!connectedRef.current && !approvalReceived) {
              sendPairRequest(bridge);
            } else {
              clearHandshakeTimers();
            }
          }, 1800);
        }
      },
      onMessage: (data: any) => {
        const msg = data as RemoteMessage;
        if (!msg || !msg.type) return;

        if (msg.type === 'invalid_code') {
          clearHandshakeTimers();
          bridge.destroy();
          bridgeRef.current = null;
          connectedRef.current = false;
          setIsConnected(false);
          setIsConnecting(false);
          setIsPendingApproval(false);
          setConnectionError(msg.message || 'Code is invalid. Check code on PC.');
          return;
        }

        if (msg.type === 'approval_required') {
          approvalReceived = true;
          clearHandshakeTimers();
          setIsConnecting(false);
          setIsPendingApproval(true);
          setConnectionError('');
          return;
        }

        if (msg.type === 'pair_approved') {
          if (msg.token) {
            localStorage.setItem('sagebot_secret_token', msg.token);
          }
          setIsPendingApproval(false);
          connectedRef.current = true;
          clearHandshakeTimers();
          setIsConnected(true);
          setIsConnecting(false);
          setConnectionError('');
          localStorage.setItem('sagebot_room_code', cleanRoom);
          bridge.send({ action: 'request_sync', type: 'request_sync' });
          showToast(`Connected to SageBot PC`);
          return;
        }

        if (msg.type === 'pair_denied') {
          setIsPendingApproval(false);
          setIsConnecting(false);
          setConnectionError('Pairing request was denied on SageBot PC.');
          clearHandshakeTimers();
          bridge.destroy();
          bridgeRef.current = null;
          return;
        }

        if (msg.type === 'force_logout') {
          clearHandshakeTimers();
          bridge.destroy();
          bridgeRef.current = null;
          connectedRef.current = false;
          setIsConnected(false);
          setIsConnecting(false);
          setIsPendingApproval(false);
          localStorage.removeItem('sagebot_secret_token');
          localStorage.removeItem('sagebot_room_code');
          setConnectionError('Host reset remote pairing code. Please enter the new code.');
          return;
        }

        // Only process data packets if already authenticated and connected
        if (!connectedRef.current) return;

        switch (msg.type) {
          case 'sync':
            if (msg.status) setStatus(msg.status);
            if (typeof msg.bot_running === 'boolean') setBotRunning(msg.bot_running);
            if (msg.roster) setRoster(msg.roster);
            if (msg.storefront) {
              setStorefront(msg.storefront);
              if (typeof msg.storefront.daily_seconds_remaining === 'number') {
                setDailySeconds(msg.storefront.daily_seconds_remaining);
              }
            }
            if (msg.pregame !== undefined) setPregame(msg.pregame);
            if (msg.logs) setLogs(msg.logs);
            break;
          case 'status':
            setStatus(msg.payload);
            break;
          case 'pregame': {
            const pg = msg.payload as PregameState | null;
            setPregame(pg);
            if (pg && pg.match_id) {
              if (handledPregameMatchIdRef.current !== pg.match_id) {
                handledPregameMatchIdRef.current = pg.match_id;
                setShowMatchWarningModal(true);
                triggerNativeNotification(
                  'Match found! Open SageBot to manually choose your agent.',
                  'match_found'
                );
              }
            } else {
              handledPregameMatchIdRef.current = '';
              setShowMatchWarningModal(false);
              setManualAgentSelectActive(false);
            }
            break;
          }
          case 'lock_result':
            setIsLocking(false);
            if (msg.success) {
              showToast(msg.message || 'Agent locked successfully!');
            } else {
              showToast(`Lock failed: ${msg.message || 'Error'}`);
            }
            break;
          case 'roster':
            setRoster(msg.payload || null);
            break;
          case 'storefront':
            setStorefront(msg.payload || null);
            if (typeof msg.payload?.daily_seconds_remaining === 'number') {
              setDailySeconds(msg.payload.daily_seconds_remaining);
            }
            break;
          case 'log':
            if (typeof msg.payload === 'string') {
              setLogs((prev) => [...prev.slice(-9), msg.payload]);
            }
            break;
          case 'screenshot':
            setScreenshotUrl(msg.payload);
            setIsCapturingScreenshot(false);
            break;
          case 'notification': {
            const notifData = (msg.payload || msg) as any;
            const isMatchFound =
              notifData.eventType === 'match_found' ||
              String(notifData.message || '').toLowerCase().includes('match found');
            if (isMatchFound) {
              setShowMatchWarningModal(true);
              triggerNativeNotification(
                'Match found! Open SageBot to manually choose your agent.',
                'match_found'
              );
            } else {
              handleIncomingNotification({
                title: notifData.title || 'SageBot',
                message: notifData.message || notifData.body || 'Notification',
                eventType: notifData.eventType || 'status',
                timestamp: Date.now(),
              });
            }
            break;
          }
          case 'toast':
          case 'action_ack':
            if (msg.payload) showToast(msg.payload);
            break;
        }
      },
    });

    bridgeRef.current = bridge;

    handshakeTimeoutRef.current = setTimeout(() => {
      if (!connectedRef.current && !approvalReceived) {
        setIsConnecting(false);
        setIsPendingApproval(false);
        setConnectionError('Code is invalid or SageBot PC is not running.');
        clearHandshakeTimers();
        if (bridgeRef.current) {
          bridgeRef.current.destroy();
          bridgeRef.current = null;
        }
      }
    }, 10000);
  };

  const sendAction = (action: string, payload?: any) => {
    if (!bridgeRef.current || !isConnected) {
      showToast('Not connected to PC');
      return;
    }
    bridgeRef.current.send({
      type: 'action',
      action,
      payload,
    });
  };

  useEffect(() => {
    if (roomCode && !isConnected && !isConnecting) {
      connectToPC(roomCode);
    }
    return () => {
      clearHandshakeTimers();
      if (bridgeRef.current) {
        bridgeRef.current.destroy();
      }
    };
  }, []);

  // Auto-reconnect when device wakes from background or network recovers
  useEffect(() => {
    const handleResume = () => {
      if (document.visibilityState === 'visible' && roomCode && !connectedRef.current && !isConnecting) {
        connectToPC(roomCode);
      }
    };
    const handleOnline = () => {
      if (roomCode && !connectedRef.current && !isConnecting) {
        connectToPC(roomCode);
      }
    };
    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('online', handleOnline);
    return () => {
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('online', handleOnline);
    };
  }, [roomCode, isConnecting]);

  const handleDisconnect = () => {
    clearHandshakeTimers();
    if (bridgeRef.current) {
      bridgeRef.current.destroy();
      bridgeRef.current = null;
    }
    connectedRef.current = false;
    setIsConnected(false);
    setIsConnecting(false);
    setIsPendingApproval(false);
    setConnectionError('');
    setStatus(null);
    setRoster(null);
    setStorefront(null);
    setScreenshotUrl(null);
    setLogs([]);
    localStorage.removeItem('sagebot_room_code');
    localStorage.removeItem('sagebot_secret_token');
    setRoomCode('');
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const clean = text.trim().toUpperCase();
      if (clean) {
        setPinInput(clean);
        showToast('Code pasted');
      }
    } catch {
      showToast('Clipboard access denied');
    }
  };

  const requestNotificationPermission = async () => {
    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      setHasNotifPermission(perm === 'granted');
      if (perm === 'granted') {
        showToast('Push notifications enabled!');
        triggerNativeNotification('Notifications active on your device.', 'setup');
      } else {
        showToast('Notification permission blocked.');
      }
    }
  };

  // State badge styling (concise: INGAME, AGENT SELECT, IN QUEUE, IN LOBBY, OFFLINE)
  const getStateBadge = (st: string) => {
    switch (st) {
      case 'In Game':
        return { label: 'INGAME', color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)' };
      case 'Agent Select':
        return { label: 'AGENT SELECT', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' };
      case 'In Queue':
        return { label: 'IN QUEUE', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)' };
      case 'In Lobby':
        return { label: 'IN LOBBY', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)' };
      default:
        return { label: 'OFFLINE', color: '#64748b', bg: 'rgba(100, 116, 139, 0.15)' };
    }
  };

  const badge = getStateBadge(status?.match_state || 'OFFLINE');

  // Defensive arrays to avoid any blank-screen rendering crashes
  const allyTeam = Array.isArray(roster?.ally_team) ? roster.ally_team : [];
  const enemyTeam = Array.isArray(roster?.enemy_team) ? roster.enemy_team : [];
  const hasRosterPlayers = allyTeam.length > 0 || enemyTeam.length > 0;

  return (
    <div className="mobile-shell">
      {/* PUSH NOTIFICATION BANNER */}
      {incomingNotification && (
        <aside className="mobile-push-notification" role="status" aria-live="polite">
          <div className="push-icon-circle">
            <Bell size={18} color="#38bdf8" />
          </div>
          <div className="push-text">
            <span className="push-title">SageBot</span>
            <span className="push-body">{incomingNotification.message}</span>
          </div>
          <button
            className="push-close-btn"
            onClick={() => setIncomingNotification(null)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </aside>
      )}

      {/* QUICK TOAST MESSAGE */}
      {toastMessage && (
        <div className="mobile-toast" role="status" aria-live="polite">
          <span>{toastMessage}</span>
        </div>
      )}

      {/* KILL VALORANT MODAL */}
      {showKillConfirm && (
        <div className="modal-backdrop" onClick={() => setShowKillConfirm(false)}>
          <div className="danger-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="danger-modal-icon">
              <Skull size={30} color="#ef4444" />
            </div>
            <h3 className="danger-modal-title">Terminate VALORANT?</h3>
            <p className="danger-modal-desc">
              Force terminates VALORANT and Riot Client immediately on your PC.
            </p>
            <div className="danger-modal-actions">
              <button className="modal-cancel-btn" onClick={() => setShowKillConfirm(false)}>
                Cancel
              </button>
              <button
                className="modal-destructive-btn"
                onClick={() => {
                  sendAction('kill_valorant');
                  setShowKillConfirm(false);
                  showToast('Terminating VALORANT on PC...');
                }}
              >
                Kill VALORANT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOP HEADER BAR: CHIBI SAGEBOT & CURRENCIES (VP, RP, KC, AGENT TOKENS) */}
      <header className="mobile-header">
        <div className="header-brand-clean">
          <img src="/sage.ico" alt="SageBot" className="brand-chibi-logo" />
          <span className="clean-app-title">SageBot</span>
        </div>

        {/* Currency badges with official VALORANT API icons */}
        <div className="header-currencies-row">
          {status?.wallet ? (
            <>
              <div className="header-currency-chip vp" title="VALORANT Points">
                <img
                  src="https://media.valorant-api.com/currencies/85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741/displayicon.png"
                  alt="VP"
                  className="header-currency-icon"
                />
                <span className="header-currency-val tabular-nums">{status.wallet.vp.toLocaleString()}</span>
              </div>
              <div className="header-currency-chip rp" title="Radianite Points">
                <img
                  src="https://media.valorant-api.com/currencies/e59aa87c-4cbf-517a-5983-6e81511be9b7/displayicon.png"
                  alt="RP"
                  className="header-currency-icon"
                />
                <span className="header-currency-val tabular-nums">{status.wallet.rp.toLocaleString()}</span>
              </div>
              <div className="header-currency-chip kc" title="Kingdom Credits">
                <img
                  src="https://media.valorant-api.com/currencies/85ca954a-41f2-ce94-9b45-8ca3dd39a00d/displayicon.png"
                  alt="KC"
                  className="header-currency-icon"
                />
                <span className="header-currency-val tabular-nums">{status.wallet.kc.toLocaleString()}</span>
              </div>
              {typeof status.wallet.agent_tokens === 'number' && (
                <div className="header-currency-chip tokens" title="Free Agent Tokens">
                  <img
                    src="https://media.valorant-api.com/currencies/f08d4ae3-939c-4576-ab26-09ce1f23bb37/displayicon.png"
                    alt="Tokens"
                    className="header-currency-icon"
                  />
                  <span className="header-currency-val tabular-nums">{status.wallet.agent_tokens.toLocaleString()}</span>
                </div>
              )}
            </>
          ) : (
            <div className="header-status-pill-subtle">
              <span className={`status-micro-dot ${isConnected ? 'green' : 'amber'}`}></span>
              <span className="status-micro-text">{isConnected ? 'v4.0' : 'Connecting'}</span>
            </div>
          )}
        </div>
      </header>

      {/* PAIRING VIEW (NOT CONNECTED) */}
      {!isConnected && (
        <main className="mobile-body pairing-body">
          <div className="sleek-pairing-card">
            <div className="pairing-hero-icon">
              <img src="/sage.ico" alt="SageBot" className="pairing-chibi-logo" />
            </div>

            <h2 className="pairing-main-title">Pair with SageBot PC</h2>
            <p className="pairing-main-desc">
              Enter the 8-character code from your PC’s <strong>Mobile Remote</strong> tab.
            </p>

            <div className="code-input-container">
              <div className="input-with-paste">
                <input
                  type="text"
                  maxLength={8}
                  placeholder="XXXXXXXX"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.toUpperCase())}
                  className="sleek-pin-input tabular-nums"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck="false"
                />
                <button
                  type="button"
                  className="paste-action-btn"
                  onClick={handlePasteClipboard}
                  title="Paste from clipboard"
                >
                  <ClipboardPaste size={16} />
                </button>
              </div>

              <button
                className="sleek-connect-btn"
                disabled={isConnecting || pinInput.trim().length < 4}
                onClick={() => connectToPC(pinInput)}
              >
                {isConnecting ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <RefreshCw size={15} className="spin" /> Connecting...
                  </span>
                ) : (
                  'Connect to PC'
                )}
              </button>
            </div>

            {isPendingApproval && (
              <div className="pending-approval-banner">
                <Radio size={16} className="pulse-icon" />
                <div className="pending-approval-text">
                  <strong>Approval Required on PC</strong>
                  <span>Please check SageBot on your PC and click Approve to pair this device.</span>
                </div>
              </div>
            )}

            {connectionError && !isPendingApproval && (
              <div className="sleek-error-callout" role="alert">
                <AlertTriangle size={15} />
                <span>{connectionError}</span>
              </div>
            )}

            <div className="pairing-footer-hint">
              <span>💡 Scanning the QR code in SageBot PC pairs automatically with zero typing.</span>
            </div>
          </div>
        </main>
      )}

      {/* CONNECTED MAIN VIEW */}
      {isConnected && (
        <main className="mobile-body">
          {/* TAB 1: STATUS (INGAME, SCREENSHOT, MINIMAL LOGS, AGENT SELECT) */}
          {activeTab === 'status' && (
            <div className="tab-pane">
              {/* IF AGENT SELECT IS IN PROGRESS BUT USER HAS NOT ACTIVATED MANUAL SELECT */}
              {!manualAgentSelectActive && (pregame !== null || status?.match_state === 'Agent Select') && (
                <div className="manual-select-toggle-banner">
                  <span className="manual-select-toggle-text">
                    ⚡ Agent Select in progress (PC Auto Active)
                  </span>
                  <button
                    type="button"
                    className="btn-toggle-manual-agent"
                    onClick={() => setManualAgentSelectActive(true)}
                  >
                    Choose Agent
                  </button>
                </div>
              )}

              {/* AGENT SELECT LIVE WORKSPACE (ACTIVE ONLY WHEN USER CONFIRMS YES) */}
              {manualAgentSelectActive && (pregame !== null || status?.match_state === 'Agent Select') && (
                <div className="agent-select-card">
                  <div className="agent-select-header">
                    <div className="agent-select-title-wrap">
                      <span className="agent-select-pulse-tag">
                        <Radio size={12} className="pulse-icon" />
                        AGENT SELECT
                      </span>
                    </div>
                    <span className="agent-select-map-info">
                      {pregame?.map_name || status?.map_name || 'VALORANT'} {pregame?.gamemode ? `• ${pregame.gamemode}` : ''}
                    </span>
                  </div>

                  {/* SMART COMP DETECTOR */}
                  <div className="smart-detector-bar">
                    <span className="smart-detector-label">Comp Check:</span>
                    {pregame?.missing_roles && pregame.missing_roles.length > 0 ? (
                      pregame.missing_roles.map((role) => (
                        <span
                          key={role}
                          className="comp-badge needed"
                          onClick={() => setSelectedRoleFilter(role)}
                          title={`Filter to ${role}s`}
                        >
                          ⚠️ Need {role}
                        </span>
                      ))
                    ) : (
                      <span className="comp-badge balanced">
                        ✅ Balanced Comp
                      </span>
                    )}
                  </div>

                  {/* LIVE TEAMMATES ROSTER (5 SLOTS) */}
                  <div className="teammates-slots-row">
                    {Array.from({ length: 5 }).map((_, idx) => {
                      const t = pregame?.teammates?.[idx];
                      if (!t) {
                        return (
                          <div key={idx} className="teammate-slot">
                            <div className="teammate-slot-avatar">
                              <span className="teammate-slot-empty">?</span>
                            </div>
                            <span className="teammate-slot-name">Slot {idx + 1}</span>
                            <span className="teammate-slot-state choosing">Waiting</span>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={t.puuid || idx}
                          className={`teammate-slot ${t.is_self ? 'is-self' : ''} ${t.is_locked ? 'is-locked' : ''}`}
                        >
                          <div className="teammate-slot-avatar">
                            {t.character_id ? (
                              <img
                                src={`https://media.valorant-api.com/agents/${t.character_id}/displayicon.png`}
                                alt={t.character_name}
                                className="teammate-slot-img"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            ) : (
                              <span className="teammate-slot-empty">?</span>
                            )}
                          </div>
                          <span className="teammate-slot-name" title={t.player_name || t.character_name}>
                            {t.is_self ? 'YOU' : t.player_name ? t.player_name.split('#')[0] : t.character_name || `Ally ${idx + 1}`}
                          </span>
                          <span
                            className={`teammate-slot-state ${t.is_locked ? 'locked' : t.character_id ? 'hovering' : 'choosing'
                              }`}
                          >
                            {t.is_locked ? 'LOCKED' : t.character_id ? 'HOVER' : 'CHOOSING'}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {/* ROLE FILTER TABS */}
                  <div className="agent-role-tabs">
                    {['ALL', 'Duelist', 'Initiator', 'Controller', 'Sentinel'].map((role) => (
                      <button
                        key={role}
                        type="button"
                        className={`agent-role-tab ${selectedRoleFilter === role ? 'active' : ''}`}
                        onClick={() => setSelectedRoleFilter(role)}
                      >
                        {role.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  {/* AGENTS ROSTER GRID */}
                  <div className="agents-roster-grid">
                    {ALL_VALORANT_AGENTS
                      .filter((a) => selectedRoleFilter === 'ALL' || a.role.toLowerCase() === selectedRoleFilter.toLowerCase())
                      .map((agent) => {
                        const isLockedByTeammate = Boolean(
                          pregame?.teammates?.some(
                            (t) => !t.is_self && t.is_locked && t.character_id.toLowerCase() === agent.id.toLowerCase()
                          )
                        );
                        const isLockedBySelf = Boolean(
                          pregame?.locked_agent_id?.toLowerCase() === agent.id.toLowerCase() ||
                          (status?.match_state === 'Agent Select' && status?.current_agent?.toLowerCase() === agent.name.toLowerCase())
                        );

                        return (
                          <div
                            key={agent.id}
                            className={`agent-pick-card ${isLockedByTeammate ? 'locked-by-teammate' : ''} ${isLockedBySelf ? 'locked-by-self' : ''
                              }`}
                            onClick={() => {
                              if (!isLockedByTeammate && !isLockedBySelf && !isLocking) {
                                setPendingAgentLock(agent);
                              }
                            }}
                          >
                            <div className="agent-card-avatar">
                              <img
                                src={`https://media.valorant-api.com/agents/${agent.id}/displayicon.png`}
                                alt={agent.name}
                                className="agent-card-img"
                                loading="lazy"
                              />
                            </div>
                            <span className="agent-card-name">{agent.name}</span>
                            <span className={`agent-card-role-tag ${agent.role.toLowerCase()}`}>
                              {agent.role}
                            </span>

                            {isLockedByTeammate && (
                              <span className="agent-taken-pill">TAKEN</span>
                            )}
                            {isLockedBySelf && (
                              <span className="agent-self-pill">YOU</span>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* PRIMARY LIVE MATCH CARD */}
              <div className="live-match-card">
                <div className="card-top-row">
                  <span className="state-badge" style={{ color: badge.color, backgroundColor: badge.bg }}>
                    {badge.label}
                  </span>
                  <span className="gamemode-text">
                    {status?.gamemode && status.gamemode !== '-' ? status.gamemode : 'VALORANT'}
                  </span>
                </div>

                {status?.match_state === 'In Game' ? (
                  <div className="score-board">
                    <div className="team-score ally">
                      <span className="score-digit tabular-nums">{status.score_ally}</span>
                      <span className="team-sub">ALLY</span>
                    </div>
                    <span className="score-sep">:</span>
                    <div className="team-score enemy">
                      <span className="score-digit tabular-nums">{status.score_enemy}</span>
                      <span className="team-sub">ENEMY</span>
                    </div>
                  </div>
                ) : (
                  <div className="match-idle-view">
                    <span className="idle-map-name">
                      {status?.map_name && status.map_name !== '-' ? status.map_name : 'No Active Match'}
                    </span>
                    <span className="idle-player-sub">
                      {status?.current_agent && status.current_agent !== '-'
                        ? `Playing as ${status.current_agent}`
                        : status?.player_name ? `${status.player_name}#${status.player_tag}` : 'VALORANT Ready'}
                    </span>
                  </div>
                )}

                <div className="quick-stats-row">
                  <div className="stat-pill">
                    <span className="stat-label">MAP</span>
                    <span className="stat-val">{status?.map_name || '-'}</span>
                  </div>
                  <div className="stat-pill">
                    <span className="stat-label">AGENT</span>
                    <span className="stat-val">{status?.current_agent || '-'}</span>
                  </div>
                  <div className="stat-pill">
                    <span className="stat-label">RANK</span>
                    <span className="stat-val">{status?.rank_name || 'Unranked'}</span>
                  </div>
                  <div className="stat-pill">
                    <span className="stat-label">SERVER</span>
                    <span className="stat-val">{roster?.server_name || status?.server_name || '-'}</span>
                  </div>
                </div>

                {/* START / STOP SAGEBOT POWER BUTTON */}
                <button
                  className={`bot-power-btn ${botRunning ? 'running' : 'stopped'}`}
                  onClick={() => sendAction('toggle_bot')}
                >
                  <Power size={18} />
                  <span>{botRunning ? 'STOP SAGEBOT' : 'START SAGEBOT'}</span>
                </button>
              </div>

              {/* SCREENSHOT CARD */}
              <div className="surface-card">
                <div className="surface-card-header">
                  <div className="header-left-title">
                    <Camera size={16} color="#38bdf8" />
                    <span className="card-heading">Screen Capture</span>
                  </div>
                  <button
                    className="screenshot-action-btn"
                    disabled={isCapturingScreenshot}
                    onClick={() => {
                      setIsCapturingScreenshot(true);
                      sendAction('take_screenshot');
                    }}
                  >
                    <RefreshCw size={14} className={isCapturingScreenshot ? 'spin' : ''} />
                    <span>{isCapturingScreenshot ? 'Capturing...' : 'Capture Game Screen'}</span>
                  </button>
                </div>

                {screenshotUrl ? (
                  <div className="screenshot-img-card">
                    <img src={screenshotUrl} alt="Live VALORANT Screen" className="screenshot-img" />
                  </div>
                ) : (
                  <div className="empty-sub-state">
                    <p>No screenshot captured yet.</p>
                    <span>Tap Capture to preview your PC's active VALORANT screen.</span>
                  </div>
                )}
              </div>

              {/* MINIMAL LOGS CARD */}
              <div className="surface-card">
                <div className="surface-card-header">
                  <div className="header-left-title">
                    <Terminal size={16} color="#38bdf8" />
                    <span className="card-heading">Recent Logs</span>
                  </div>
                </div>

                <div className="minimal-logs-console">
                  {logs.length === 0 ? (
                    <span className="logs-empty">No activity recorded yet.</span>
                  ) : (
                    logs.map((line, idx) => (
                      <div key={idx} className="log-item">
                        <span className="log-line-text">{line}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: TRACKER (FULL VERIFIED ROSTER FROM PC - SAFE GUARDED) */}
          {activeTab === 'tracker' && (
            <div className="tab-pane">
              <div className="surface-card">
                <div className="surface-card-header">
                  <div>
                    <h3 className="card-heading">Match Tracker</h3>
                    <span className="card-subheading">
                      {roster?.map_name || status?.map_name || 'VALORANT'} • {roster?.gamemode || status?.gamemode || 'Match'}
                    </span>
                  </div>
                  <button
                    className="icon-refresh-btn"
                    onClick={() => sendAction('refresh_roster')}
                    aria-label="Refresh tracker"
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>

                {!hasRosterPlayers ? (
                  <div className="empty-sub-state">
                    <Users size={36} color="#64748b" />
                    <p>No active match roster detected.</p>
                    <span>Populates automatically when you enter Agent Select or In-Game on PC.</span>
                  </div>
                ) : (
                  <div className="teams-scroll-container">
                    {/* ALLY TEAM */}
                    {allyTeam.length > 0 && (
                      <div className="team-block ally-team">
                        <span className="team-block-title ally">ALLY TEAM</span>
                        <div className="players-list">
                          {allyTeam.map((player: TrackedPlayer) => (
                            <div key={player.puuid || player.name} className="roster-player-card ally">
                              <div className="player-agent-col">
                                {player.party_tag ? (
                                  <div className={`party-indicator-capsule ${getPartyClass(player.party_tag)}`} />
                                ) : (
                                  <div className="party-indicator-capsule-spacer" />
                                )}
                                {player.agent_id ? (
                                  <img
                                    src={`https://media.valorant-api.com/agents/${player.agent_id}/displayicon.png`}
                                    alt={player.agent_name}
                                    className="player-agent-icon"
                                    onError={(e) => {
                                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                                    }}
                                  />
                                ) : (
                                  <div className="agent-fallback-avatar">
                                    <span>{player.agent_name?.slice(0, 2) || 'VA'}</span>
                                  </div>
                                )}
                              </div>

                              <div className="player-info-col">
                                <div className="player-name-row">
                                  <span className="player-display-name">{player.name}</span>
                                  {player.is_self && <span className="self-tag">YOU</span>}
                                </div>
                                <span className="player-agent-name">{player.agent_name || 'Agent'}</span>
                              </div>

                              <div className="player-stats-col">
                                <span className="player-rank-title" style={{ color: getRankColor(player.current_rank_name) }}>
                                  {player.current_rank_name || 'Unranked'}
                                </span>
                                <div className="stats-sub-row tabular-nums">
                                  <span
                                    className="player-wr"
                                    style={{
                                      color:
                                        player.win_rate >= 50
                                          ? '#10b981'
                                          : player.win_rate >= 45
                                            ? '#f59e0b'
                                            : '#f43f5e',
                                    }}
                                  >
                                    {player.win_rate ? `${Math.round(player.win_rate)}%` : '-'}
                                  </span>
                                  {player.kd_ratio && (
                                    <span
                                      className="player-kd"
                                      style={{ color: player.kd_ratio >= 1.0 ? '#38bdf8' : '#94a3b8' }}
                                    >
                                      {player.kd_ratio.toFixed(2)} KD
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ENEMY TEAM */}
                    {enemyTeam.length > 0 && (
                      <div className="team-block enemy-team" style={{ marginTop: '16px' }}>
                        <span className="team-block-title enemy">ENEMY TEAM</span>
                        <div className="players-list">
                          {enemyTeam.map((player: TrackedPlayer) => (
                            <div key={player.puuid || player.name} className="roster-player-card enemy">
                              <div className="player-agent-col">
                                {player.party_tag ? (
                                  <div className={`party-indicator-capsule ${getPartyClass(player.party_tag)}`} />
                                ) : (
                                  <div className="party-indicator-capsule-spacer" />
                                )}
                                {player.agent_id ? (
                                  <img
                                    src={`https://media.valorant-api.com/agents/${player.agent_id}/displayicon.png`}
                                    alt={player.agent_name}
                                    className="player-agent-icon"
                                    onError={(e) => {
                                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                                    }}
                                  />
                                ) : (
                                  <div className="agent-fallback-avatar">
                                    <span>{player.agent_name?.slice(0, 2) || 'VA'}</span>
                                  </div>
                                )}
                              </div>

                              <div className="player-info-col">
                                <div className="player-name-row">
                                  <span className="player-display-name">{player.name}</span>
                                </div>
                                <span className="player-agent-name">{player.agent_name || 'Agent'}</span>
                              </div>

                              <div className="player-stats-col">
                                <span className="player-rank-title" style={{ color: getRankColor(player.current_rank_name) }}>
                                  {player.current_rank_name || 'Unranked'}
                                </span>
                                <div className="stats-sub-row tabular-nums">
                                  <span
                                    className="player-wr"
                                    style={{
                                      color:
                                        player.win_rate >= 50
                                          ? '#10b981'
                                          : player.win_rate >= 45
                                            ? '#f59e0b'
                                            : '#f43f5e',
                                    }}
                                  >
                                    {player.win_rate ? `${Math.round(player.win_rate)}%` : '-'}
                                  </span>
                                  {player.kd_ratio && (
                                    <span
                                      className="player-kd"
                                      style={{ color: player.kd_ratio >= 1.0 ? '#38bdf8' : '#94a3b8' }}
                                    >
                                      {player.kd_ratio.toFixed(2)} KD
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: SHOP (FEATURED BUNDLE, DAILY OFFERS, NIGHT MARKET, ACCESSORY) */}
          {activeTab === 'shop' && (
            <div className="tab-pane">
              <div className="surface-card">
                <div className="surface-card-header">
                  <div>
                    <h3 className="card-heading">Shop</h3>
                    <span className="card-subheading">
                      {dailySeconds > 0
                        ? `Daily offers reset in ${formatCountdownDHMS(dailySeconds)}`
                        : 'Storefront'}
                    </span>
                  </div>
                  <button
                    className="icon-refresh-btn"
                    onClick={() => sendAction('request_storefront')}
                    aria-label="Refresh shop"
                  >
                    <RefreshCw size={15} />
                  </button>
                </div>

                {!storefront ? (
                  <div className="empty-sub-state">
                    <ShoppingBag size={36} color="#64748b" />
                    <p>Shop not loaded yet.</p>
                    <span>Tap refresh to fetch verified store offers from SageBot PC.</span>
                    <button
                      className="load-shop-btn"
                      onClick={() => sendAction('request_storefront')}
                    >
                      Fetch Shop
                    </button>
                  </div>
                ) : (
                  <div className="shop-scroll-layout">
                    {/* FEATURED BUNDLE */}
                    {storefront.featured_bundles && storefront.featured_bundles.length > 0 && (
                      <div className="bundle-feature-block">
                        <span className="shop-subheading">FEATURED BUNDLE</span>
                        {storefront.featured_bundles.map((bundle) => (
                          <div key={bundle.bundle_id} className="bundle-card">
                            {bundle.display_icon && (
                              <img src={bundle.display_icon} alt={bundle.name} className="bundle-cover-img" />
                            )}
                            <div className="bundle-meta">
                              <span className="bundle-name">{bundle.name}</span>
                              <div className="bundle-price-row">
                                <span className="time-left tabular-nums">
                                  <Clock size={12} /> {formatCountdownDHMS(bundle.seconds_remaining)}
                                </span>
                                <span className="price-vp-pill tabular-nums">
                                  {bundle.total_cost_vp.toLocaleString()} VP
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* DAILY 4 WEAPON SKINS */}
                    {storefront.daily_offers && storefront.daily_offers.length > 0 && (
                      <div className="daily-offers-block" style={{ marginTop: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span className="shop-subheading">DAILY OFFERS</span>
                          {dailySeconds > 0 && (
                            <span style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>
                              ⏱ {formatCountdownDHMS(dailySeconds)}
                            </span>
                          )}
                        </div>
                        <div className="daily-skins-grid">
                          {storefront.daily_offers.map((offer) => (
                            <div key={offer.offer_id} className="daily-skin-tile">
                              <div className="skin-preview-wrap">
                                {offer.icon_url ? (
                                  <img src={offer.icon_url} alt={offer.skin_name} className="skin-thumb" />
                                ) : (
                                  <ShoppingBag size={24} color="#64748b" />
                                )}
                              </div>
                              <div className="skin-tile-footer">
                                <span className="skin-title">{offer.skin_name}</span>
                                <div className="skin-bottom-line">
                                  <span className="skin-weapon">{offer.weapon_name}</span>
                                  <span className="skin-cost tabular-nums">{offer.cost_vp.toLocaleString()} VP</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* NIGHT.MARKET (IF ACTIVE) */}
                    {storefront.night_market_active && storefront.night_market_offers && storefront.night_market_offers.length > 0 && (
                      <div className="night-market-block" style={{ marginTop: '20px' }}>
                        <div className="nm-header-row">
                          <span className="shop-subheading purple">NIGHT.MARKET</span>
                          <span className="nm-countdown tabular-nums">
                            {formatCountdownDHMS(storefront.night_market_seconds_remaining)}
                          </span>
                        </div>

                        <div className="daily-skins-grid">
                          {storefront.night_market_offers.map((nm) => (
                            <div key={nm.offer_id} className="daily-skin-tile nm-tile">
                              <span className="discount-tag tabular-nums">-{nm.discount_percent}%</span>
                              <div className="skin-preview-wrap">
                                {nm.icon_url && <img src={nm.icon_url} alt={nm.skin_name} className="skin-thumb" />}
                              </div>
                              <div className="skin-tile-footer">
                                <span className="skin-title">{nm.skin_name}</span>
                                <div className="skin-bottom-line">
                                  <span className="orig-price-strike tabular-nums">{nm.original_cost_vp}</span>
                                  <span className="skin-cost purple tabular-nums">
                                    {nm.discounted_cost_vp.toLocaleString()} VP
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: SETTINGS (VERSION, NOTIFICATIONS PREFERENCES, KILL VALORANT, LOGOUT) */}
          {activeTab === 'settings' && (
            <div className="tab-pane">
              {/* VERSION CARD */}
              <div className="surface-card version-card">
                <div className="version-info-row">
                  <div className="version-brand">
                    <img src="/sage.ico" alt="SageBot" className="brand-chibi-logo" />
                    <div>
                      <h3 className="version-title">SageBot</h3>
                      <span className="version-badge">v4.0</span>
                    </div>
                  </div>
                </div>
                <p className="version-desc">
                  SageBot is a multi-functional, external VALORANT utility.
                </p>
              </div>

              {/* NOTIFICATION PREFERENCES CARD */}
              <div className="surface-card">
                <div className="surface-card-header">
                  <div className="header-left-title">
                    <Bell size={16} color="#38bdf8" />
                    <span className="card-heading">Phone Notifications</span>
                  </div>
                  {!hasNotifPermission && (
                    <button className="enable-notif-btn" onClick={requestNotificationPermission}>
                      <span>Enable System Push</span>
                    </button>
                  )}
                  {hasNotifPermission && (
                    <span className="notif-active-badge">
                      <Check size={13} /> Permission Granted
                    </span>
                  )}
                </div>

                <div className="notif-toggles-list">
                  <div className="notif-toggle-row">
                    <div className="notif-text-col">
                      <span className="notif-opt-title">Disconnect &amp; Reconnect Alerts</span>
                      <span className="notif-opt-sub">Alert when SageBot or VALORANT disconnects</span>
                    </div>
                    <label className="switch-label">
                      <input
                        type="checkbox"
                        checked={notifPrefs.disconnect}
                        onChange={(e) => updateNotifPref('disconnect', e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                  </div>

                  <div className="notif-toggle-row">
                    <div className="notif-text-col">
                      <span className="notif-opt-title">Match State Alerts</span>
                      <span className="notif-opt-sub">Alert on Queue pop, Agent Select, and In-Game</span>
                    </div>
                    <label className="switch-label">
                      <input
                        type="checkbox"
                        checked={notifPrefs.status}
                        onChange={(e) => updateNotifPref('status', e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                  </div>

                  <div className="notif-toggle-row">
                    <div className="notif-text-col">
                      <span className="notif-opt-title">Rank &amp; RR Updates</span>
                      <span className="notif-opt-sub">Alert when competitive rank or RR updates</span>
                    </div>
                    <label className="switch-label">
                      <input
                        type="checkbox"
                        checked={notifPrefs.rank}
                        onChange={(e) => updateNotifPref('rank', e.target.checked)}
                      />
                      <span className="switch-slider"></span>
                    </label>
                  </div>
                </div>
              </div>

              {/* DANGER ZONE CARD */}
              <div className="danger-surface-card">
                <div className="danger-card-header">
                  <AlertTriangle size={18} color="#ef4444" />
                  <span className="danger-heading">Danger Zone</span>
                </div>

                <div className="danger-options-list">
                  <div className="danger-row">
                    <div className="danger-row-meta">
                      <span className="danger-opt-name">Kill VALORANT</span>
                      <span className="danger-opt-desc">Force terminate VALORANT and Riot Client on your PC.</span>
                    </div>
                    <button className="btn-kill-action" onClick={() => setShowKillConfirm(true)}>
                      <Skull size={15} />
                      <span>Kill VALORANT</span>
                    </button>
                  </div>

                  <div className="danger-row">
                    <div className="danger-row-meta">
                      <span className="danger-opt-name">Logout &amp; Unpair</span>
                      <span className="danger-opt-desc">Disconnect remote session and clear saved room code.</span>
                    </div>
                    <button className="btn-logout-action" onClick={handleDisconnect}>
                      <LogOut size={15} />
                      <span>Logout</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* VERIFY LOCK CONFIRMATION MODAL */}
      {pendingAgentLock && (
        <div className="agent-confirm-backdrop" onClick={() => !isLocking && setPendingAgentLock(null)}>
          <div className="agent-confirm-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="agent-confirm-portrait">
              <img
                src={`https://media.valorant-api.com/agents/${pendingAgentLock.id}/displayicon.png`}
                alt={pendingAgentLock.name}
              />
            </div>
            <h3 className="agent-confirm-name">{pendingAgentLock.name}</h3>
            <span
              className={`agent-confirm-role ${pendingAgentLock.role.toLowerCase()}`}
              style={{
                color:
                  pendingAgentLock.role === 'Duelist'
                    ? '#ff4655'
                    : pendingAgentLock.role === 'Initiator'
                      ? '#38bdf8'
                      : pendingAgentLock.role === 'Controller'
                        ? '#a855f7'
                        : '#10b981',
              }}
            >
              {pendingAgentLock.role}
            </span>
            <p className="agent-confirm-prompt">
              Do you wish to lock in <strong>{pendingAgentLock.name}</strong>?
              <br />
              <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                This overrides PC auto-queue and locks immediately.
              </span>
            </p>
            <div className="agent-confirm-actions">
              <button
                type="button"
                className="btn-cancel-lock"
                disabled={isLocking}
                onClick={() => setPendingAgentLock(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-confirm-lock"
                disabled={isLocking}
                onClick={() => {
                  setIsLocking(true);
                  sendAction('remote_lock_agent', {
                    agentId: pendingAgentLock.id,
                    agentName: pendingAgentLock.name,
                  });
                  setPendingAgentLock(null);
                }}
              >
                {isLocking ? 'Locking...' : `Lock In ${pendingAgentLock.name}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MATCH FOUND WARNING MODAL (MANUAL SELECTION PROMPT) */}
      {showMatchWarningModal && (
        <div className="agent-confirm-backdrop">
          <div className="agent-confirm-sheet warning-sheet">
            <div className="warning-icon-badge">
              <AlertTriangle size={30} color="#fbbf24" />
            </div>
            <h3 className="warning-modal-title">Match Found!</h3>
            <p className="warning-modal-desc">
              Do you want to manually choose your agent from your phone?
            </p>
            <span className="warning-modal-sub">
              If not, SageBot PC will automatically lock agents according to your PC settings.
            </span>
            <div className="warning-modal-actions">
              <button
                type="button"
                className="btn-choose-manual"
                onClick={() => {
                  setShowMatchWarningModal(false);
                  setManualAgentSelectActive(true);
                  setActiveTab('status');
                }}
              >
                Yes, Choose Agent
              </button>
              <button
                type="button"
                className="btn-keep-pc-settings"
                onClick={() => {
                  setShowMatchWarningModal(false);
                  setManualAgentSelectActive(false);
                }}
              >
                No, Keep PC Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FOOTER NAVIGATION BAR: EXACTLY 4 TABS */}
      {isConnected && (
        <nav className="mobile-nav-footer" aria-label="Bottom Navigation">
          <button
            className={`footer-nav-btn ${activeTab === 'status' ? 'active' : ''}`}
            onClick={() => setActiveTab('status')}
            aria-selected={activeTab === 'status'}
          >
            <Activity size={20} />
            <span>Status</span>
          </button>

          <button
            className={`footer-nav-btn ${activeTab === 'tracker' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('tracker');
              sendAction('refresh_roster');
            }}
            aria-selected={activeTab === 'tracker'}
          >
            <Users size={20} />
            <span>Tracker</span>
          </button>

          <button
            className={`footer-nav-btn ${activeTab === 'shop' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('shop');
              sendAction('request_storefront');
            }}
            aria-selected={activeTab === 'shop'}
          >
            <ShoppingBag size={20} />
            <span>Shop</span>
          </button>

          <button
            className={`footer-nav-btn ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveTab('settings')}
            aria-selected={activeTab === 'settings'}
          >
            <Settings size={20} />
            <span>Settings</span>
          </button>
        </nav>
      )}
    </div>
  );
}

export default App;