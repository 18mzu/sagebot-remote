import { useState, useEffect, useRef } from 'react';
import {
  Menu,
  X,
  Shield,
  Sliders,
  Users,
  ShoppingBag,
  Activity,
  Power,
  Camera,
  AlertTriangle,
  Play,
  Flame,
  RotateCcw,
  Sparkles,
  RefreshCw,
  Radio,
  LogOut,
  Skull,
  MessageSquare,
  Vote,
  Crosshair,
  Bell,
  Coins,
  ChevronRight,
} from 'lucide-react';
import { RemoteBridge } from './remoteBridge';
import type {
  MobileClientStatus,
  MobileBotConfig,
  PlayerRosterItem,
  RemoteMessage,
  StorefrontData,
  RemoteNotification,
} from './types';
import './App.css';

// Valorant Agent Directory
const VALORANT_AGENTS = [
  'Astra', 'Breach', 'Brimstone', 'Chamber', 'Clove', 'Cypher',
  'Deadlock', 'Fade', 'Gekko', 'Harbor', 'Iso', 'Jett',
  'KAY/O', 'Killjoy', 'Neon', 'Omen', 'Phoenix', 'Raze',
  'Reyna', 'Sage', 'Skye', 'Sova', 'Tejo', 'Viper',
  'Vyse', 'Waylay', 'Yoru',
];

export function App() {
  const [roomCode, setRoomCode] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
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
  const [connectionError, setConnectionError] = useState<string>('');

  // Primary Bottom Nav Tab: 'config' | 'tracker' | 'status'
  const [activeTab, setActiveTab] = useState<'config' | 'tracker' | 'status'>('config');

  // Sub-tabs
  const [configSubTab, setConfigSubTab] = useState<'automation' | 'agents' | 'chat' | 'voting'>('automation');
  const [trackerSubTab, setTrackerSubTab] = useState<'roster' | 'shop'>('roster');
  const [statusSubTab, setStatusSubTab] = useState<'screenshot' | 'danger'>('screenshot');

  // Drawer state
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);

  // Status & live data received from PC
  const [status, setStatus] = useState<MobileClientStatus | null>(null);
  const [botConfig, setBotConfig] = useState<MobileBotConfig>({
    bot_running: false,
    anti_afk_enabled: true,
    auto_reconnect: false,
    auto_ff_enabled: false,
    auto_kj_turret: false,
    auto_queue_enabled: false,
    auto_queue_mode: 'competitive',
    lock_random_agent: false,
    low_detail: false,
    agents_enabled: true,
    instalock_enabled: false,
    lock_delay: 20,
    starter_fallback_enabled: false,
    selected_agents: ['Jett'],
    chat_enabled: false,
    chat_target: 0,
    chat_interval: 180,
    chat_text: 'With great Power comes great Responsibility',
    auto_ff_round_5: true,
    auto_ff_round_13: false,
    auto_ff_round_14: false,
    remote_notify_disconnect: true,
    remote_notify_status: true,
    remote_notify_rank_change: true,
  });

  const [roster, setRoster] = useState<PlayerRosterItem[]>([]);
  const [storefront, setStorefront] = useState<StorefrontData | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [incomingNotification, setIncomingNotification] = useState<RemoteNotification | null>(null);

  // Confirmation modal for Kill VALORANT
  const [showKillConfirm, setShowKillConfirm] = useState<boolean>(false);

  // Search filter for agent picker
  const [agentSearch, setAgentSearch] = useState<string>('');

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
    }, 3200);
  };

  // Dispatch Web Notification if permitted + vibrate
  const handleIncomingNotification = (notif: RemoteNotification) => {
    setIncomingNotification(notif);

    // Vibration feedback on supported devices
    if ('vibrate' in navigator) {
      try {
        navigator.vibrate([120, 60, 120]);
      } catch {
        // ignore
      }
    }

    // Web Notification API (shows banner on device lockscreen / notification center)
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(notif.title, {
          body: notif.message,
          icon: '/favicon.ico',
          tag: notif.eventType,
        });
      } catch {
        // ignore
      }
    }

    setTimeout(() => {
      setIncomingNotification((prev) => (prev?.timestamp === notif.timestamp ? null : prev));
    }, 5500);
  };

  // Connect to PC over Dual-Broker WSS Bridge
  const connectToPC = (targetRoom: string) => {
    const cleanRoom = targetRoom.trim().toUpperCase();
    if (!cleanRoom || cleanRoom.length < 4) {
      setConnectionError('Please enter a valid 6-digit room code');
      return;
    }

    // Request notification permission smoothly
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    setRoomCode(cleanRoom);
    setPinInput(cleanRoom);
    setIsConnecting(true);
    setConnectionError('');
    connectedRef.current = false;
    clearHandshakeTimers();

    if (bridgeRef.current) {
      bridgeRef.current.destroy();
      bridgeRef.current = null;
    }

    const bridge = new RemoteBridge(cleanRoom, 'mobile', {
      onBrokerReady: () => {
        bridge.send({ action: 'request_sync', type: 'request_sync' });
        if (!handshakeIntervalRef.current) {
          handshakeIntervalRef.current = setInterval(() => {
            if (!connectedRef.current) {
              bridge.send({ action: 'request_sync', type: 'request_sync' });
            }
          }, 1200);
        }
      },
      onMessage: (data: any) => {
        const msg = data as RemoteMessage;
        if (!msg || !msg.type) return;

        if (!connectedRef.current) {
          connectedRef.current = true;
          clearHandshakeTimers();
          setIsConnected(true);
          setIsConnecting(false);
          setConnectionError('');
          localStorage.setItem('sagebot_room_code', cleanRoom);
          showToast('Connected to SageBot PC');
        }

        switch (msg.type) {
          case 'sync':
            if (msg.status) setStatus(msg.status);
            if (msg.config) setBotConfig((prev) => ({ ...prev, ...msg.config }));
            if (msg.roster) setRoster(msg.roster);
            break;
          case 'status':
            setStatus(msg.payload);
            break;
          case 'config':
            setBotConfig((prev) => ({ ...prev, ...msg.payload }));
            break;
          case 'roster':
            setRoster(msg.payload || []);
            break;
          case 'storefront':
            setStorefront(msg.payload || null);
            break;
          case 'screenshot':
            setScreenshotUrl(msg.payload);
            setIsCapturingScreenshot(false);
            break;
          case 'notification':
            if (msg.payload) {
              handleIncomingNotification(msg.payload as RemoteNotification);
            }
            break;
          case 'toast':
          case 'action_ack':
            if (msg.payload) showToast(msg.payload);
            break;
        }
      },
    });

    bridgeRef.current = bridge;

    handshakeTimeoutRef.current = setTimeout(() => {
      if (!connectedRef.current) {
        setIsConnecting(false);
        setConnectionError(
          `Waiting for SageBot PC (${cleanRoom})... Ensure SageBot is running on your PC with Mobile Remote enabled.`
        );
      }
    }, 8000);
  };

  // Send action packet to PC
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

  // Send config update to PC
  const updateConfig = (patch: Partial<MobileBotConfig>) => {
    setBotConfig((prev) => ({ ...prev, ...patch }));
    sendAction('update_config', patch);
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

  const handleDisconnect = () => {
    clearHandshakeTimers();
    if (bridgeRef.current) {
      bridgeRef.current.destroy();
      bridgeRef.current = null;
    }
    connectedRef.current = false;
    setIsConnected(false);
    setIsConnecting(false);
    setConnectionError('');
    setStatus(null);
    setStorefront(null);
    setRoster([]);
    setScreenshotUrl(null);
    localStorage.removeItem('sagebot_room_code');
    setRoomCode('');
    setIsDrawerOpen(false);
  };

  // Map state badge
  const getStateBadge = (st: string) => {
    switch (st) {
      case 'In Game':
        return { label: 'LIVE IN GAME', color: '#10b981', bg: 'rgba(16, 185, 129, 0.15)' };
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

  // Format seconds to HH:MM:SS
  const formatCountdown = (secs?: number) => {
    if (!secs || secs <= 0) return '00:00:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const selectedAgentName = botConfig.selected_agents?.[0] || 'Jett';

  return (
    <div className="mobile-shell">
      {/* PUSH NOTIFICATION BANNER (FLOAT ON TOP) */}
      {incomingNotification && (
        <aside className="mobile-push-notification" role="status" aria-live="polite">
          <div className="push-icon-circle">
            <Bell size={18} color="#38bdf8" />
          </div>
          <div className="push-text">
            <span className="push-title">{incomingNotification.title}</span>
            <span className="push-body">{incomingNotification.message}</span>
          </div>
          <button
            className="push-close-btn"
            onClick={() => setIncomingNotification(null)}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </aside>
      )}

      {/* QUICK TOAST MESSAGE */}
      {toastMessage && (
        <div className="mobile-toast" role="status" aria-live="polite">
          <Sparkles size={15} className="toast-icon" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* KILL VALORANT CONFIRMATION MODAL */}
      {showKillConfirm && (
        <div className="modal-backdrop" onClick={() => setShowKillConfirm(false)}>
          <div className="danger-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="danger-modal-icon">
              <Skull size={32} color="#ef4444" />
            </div>
            <h3 className="danger-modal-title">Terminate VALORANT?</h3>
            <p className="danger-modal-desc">
              This will immediately force-close VALORANT and Riot Client on your PC. Any unsaved in-game match will be exited.
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
                Force Kill
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOP BAR: LEFT MENU BUTTON | RIGHT SAGEBOT TITLE & STATUS */}
      <header className="mobile-header">
        <div className="header-left">
          {isConnected && (
            <button
              className="menu-trigger-btn"
              onClick={() => setIsDrawerOpen(true)}
              aria-label="Open Navigation Drawer"
            >
              <Menu size={22} color="#f8fafc" />
            </button>
          )}
        </div>

        <div className="header-right">
          <div className="brand-stack">
            <div className="brand-line">
              <span className="app-title">SageBot</span>
              <span className="remote-pill">REMOTE</span>
            </div>
            <div className="status-pill-small">
              {isConnected ? (
                <span className="conn-status online">
                  <span className="status-dot green"></span>
                  Connected • {roomCode.toUpperCase()}
                </span>
              ) : isConnecting ? (
                <span className="conn-status connecting">
                  <span className="status-dot amber"></span>
                  Connecting...
                </span>
              ) : (
                <span className="conn-status offline">
                  <span className="status-dot red"></span>
                  Offline
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* SLIDE-OUT LEFT DRAWER / SIDEBAR */}
      {isConnected && (
        <>
          <div
            className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`}
            onClick={() => setIsDrawerOpen(false)}
          />
          <aside className={`mobile-drawer ${isDrawerOpen ? 'open' : ''}`} aria-label="Main Navigation Drawer">
            <div className="drawer-header">
              <div className="drawer-brand">
                <div className="app-icon-circle small">
                  <Shield size={16} color="#38bdf8" />
                </div>
                <div className="drawer-title-group">
                  <span className="drawer-title">SageBot Menu</span>
                  <span className="drawer-sub">Room #{roomCode}</span>
                </div>
              </div>
              <button
                className="drawer-close-btn"
                onClick={() => setIsDrawerOpen(false)}
                aria-label="Close Navigation Drawer"
              >
                <X size={20} />
              </button>
            </div>

            <nav className="drawer-body">
              {/* SECTION 1: CONFIGS */}
              <div className="drawer-section">
                <span className="drawer-section-title">CONFIGS</span>

                <button
                  className={`drawer-item ${activeTab === 'config' && configSubTab === 'automation' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('config');
                    setConfigSubTab('automation');
                    setIsDrawerOpen(false);
                  }}
                >
                  <Sliders size={18} />
                  <span>Automation</span>
                  <ChevronRight size={15} className="drawer-chevron" />
                </button>

                <button
                  className={`drawer-item ${activeTab === 'config' && configSubTab === 'agents' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('config');
                    setConfigSubTab('agents');
                    setIsDrawerOpen(false);
                  }}
                >
                  <Crosshair size={18} />
                  <span>Agents</span>
                  <ChevronRight size={15} className="drawer-chevron" />
                </button>

                <button
                  className={`drawer-item ${activeTab === 'config' && configSubTab === 'chat' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('config');
                    setConfigSubTab('chat');
                    setIsDrawerOpen(false);
                  }}
                >
                  <MessageSquare size={18} />
                  <span>Chat</span>
                  <ChevronRight size={15} className="drawer-chevron" />
                </button>

                <button
                  className={`drawer-item ${activeTab === 'config' && configSubTab === 'voting' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('config');
                    setConfigSubTab('voting');
                    setIsDrawerOpen(false);
                  }}
                >
                  <Vote size={18} />
                  <span>Voting</span>
                  <ChevronRight size={15} className="drawer-chevron" />
                </button>
              </div>

              {/* SECTION 2: TRACKER */}
              <div className="drawer-section">
                <span className="drawer-section-title">TRACKER</span>

                <button
                  className={`drawer-item ${activeTab === 'tracker' && trackerSubTab === 'roster' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('tracker');
                    setTrackerSubTab('roster');
                    sendAction('refresh_roster');
                    setIsDrawerOpen(false);
                  }}
                >
                  <Users size={18} />
                  <span>Match Tracker</span>
                  <ChevronRight size={15} className="drawer-chevron" />
                </button>

                <button
                  className={`drawer-item ${activeTab === 'tracker' && trackerSubTab === 'shop' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('tracker');
                    setTrackerSubTab('shop');
                    sendAction('request_storefront');
                    setIsDrawerOpen(false);
                  }}
                >
                  <ShoppingBag size={18} />
                  <span>Daily Shop</span>
                  <ChevronRight size={15} className="drawer-chevron" />
                </button>
              </div>

              {/* SECTION 3: STATUS */}
              <div className="drawer-section">
                <span className="drawer-section-title">STATUS</span>

                <button
                  className={`drawer-item ${activeTab === 'status' && statusSubTab === 'screenshot' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('status');
                    setStatusSubTab('screenshot');
                    setIsDrawerOpen(false);
                  }}
                >
                  <Camera size={18} />
                  <span>Screenshot</span>
                  <ChevronRight size={15} className="drawer-chevron" />
                </button>

                <button
                  className={`drawer-item danger ${activeTab === 'status' && statusSubTab === 'danger' ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTab('status');
                    setStatusSubTab('danger');
                    setIsDrawerOpen(false);
                  }}
                >
                  <AlertTriangle size={18} />
                  <span>Danger Zone</span>
                  <ChevronRight size={15} className="drawer-chevron" />
                </button>
              </div>
            </nav>

            <div className="drawer-footer">
              <button className="drawer-logout-btn" onClick={handleDisconnect}>
                <LogOut size={16} />
                <span>Disconnect Room</span>
              </button>
            </div>
          </aside>
        </>
      )}

      {/* PAIRING VIEW (NOT CONNECTED) */}
      {!isConnected && (
        <main className="mobile-body pairing-body">
          <div className="pairing-card">
            <div className="pairing-header">
              <div className="icon-pairing-badge">
                <Radio size={28} color="#38bdf8" />
              </div>
              <h2 className="pairing-title">Pair with SageBot PC</h2>
              <p className="pairing-desc">
                Open SageBot on your PC, click <strong>Mobile Remote</strong> in the sidebar, and enter your 6-digit room code.
              </p>
            </div>

            <div className="pin-input-group">
              <input
                type="text"
                maxLength={6}
                placeholder="6-DIGIT CODE"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.toUpperCase())}
                className="pin-code-input tabular-nums"
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
              />
              <button
                className="connect-btn"
                disabled={isConnecting || pinInput.trim().length < 4}
                onClick={() => connectToPC(pinInput)}
              >
                {isConnecting ? 'Connecting...' : 'Connect to PC'}
              </button>
            </div>

            {connectionError && (
              <div className="error-callout" role="alert">
                <AlertTriangle size={16} />
                <span>{connectionError}</span>
              </div>
            )}

            <div className="pairing-hint">
              <span>Scanning the QR code on PC connects automatically with zero typing.</span>
            </div>
          </div>
        </main>
      )}

      {/* MAIN CONNECTED CONTENT */}
      {isConnected && (
        <main className="mobile-body">
          {/* TAB 1: CONFIG (LIVE IN-GAME PINNED ON TOP + DYNAMIC CONFIG SUBVIEWS) */}
          {activeTab === 'config' && (
            <div className="tab-pane">
              {/* PINNED IN-GAME MATCH STATE & POWER BUTTON (ALWAYS VISIBLE ON CONFIG TAB) */}
              <div className="pinned-hero-surface">
                <div className="surface-top">
                  <span className="state-badge" style={{ color: badge.color, backgroundColor: badge.bg }}>
                    {badge.label}
                  </span>
                  <span className="gamemode-label">
                    {status?.gamemode && status.gamemode !== '-' ? status.gamemode : 'VALORANT'}
                  </span>
                </div>

                {status?.match_state === 'In Game' ? (
                  <div className="score-hero">
                    <div className="score-team ally">
                      <span className="score-num tabular-nums">{status.score_ally}</span>
                      <span className="score-tag">ALLY</span>
                    </div>
                    <span className="score-divider">:</span>
                    <div className="score-team enemy">
                      <span className="score-num tabular-nums">{status.score_enemy}</span>
                      <span className="score-tag">ENEMY</span>
                    </div>
                  </div>
                ) : (
                  <div className="match-idle-hero">
                    <span className="map-name-display">
                      {status?.map_name && status.map_name !== '-' ? status.map_name : 'No Active Match'}
                    </span>
                    <span className="agent-name-display">
                      {status?.current_agent && status.current_agent !== '-'
                        ? `Playing as ${status.current_agent}`
                        : status?.player_name ? `${status.player_name}#${status.player_tag}` : 'VALORANT Ready'}
                    </span>
                  </div>
                )}

                <div className="surface-stats-grid">
                  <div className="stat-slot">
                    <span className="slot-title">MAP</span>
                    <span className="slot-value">{status?.map_name || '-'}</span>
                  </div>
                  <div className="stat-slot">
                    <span className="slot-title">AGENT</span>
                    <span className="slot-value">{status?.current_agent || '-'}</span>
                  </div>
                  <div className="stat-slot">
                    <span className="slot-title">RANK</span>
                    <span className="slot-value">{status?.rank_name || 'Unranked'}</span>
                  </div>
                  <div className="stat-slot">
                    <span className="slot-title">BOT STATUS</span>
                    <span className={`slot-value ${botConfig.bot_running ? 'online' : 'offline'}`}>
                      {botConfig.bot_running ? 'ACTIVE' : 'STOPPED'}
                    </span>
                  </div>
                </div>

                {/* PINNED SAGEBOT START / STOP BUTTON */}
                <button
                  className={`primary-power-btn ${botConfig.bot_running ? 'running' : 'stopped'}`}
                  onClick={() => sendAction('toggle_bot')}
                >
                  <Power size={20} />
                  <span>{botConfig.bot_running ? 'STOP SAGEBOT' : 'START SAGEBOT'}</span>
                </button>
              </div>

              {/* CONFIG SUB-TABS PILL BAR */}
              <div className="sub-pills-bar" role="tablist" aria-label="Config Sub-views">
                <button
                  role="tab"
                  aria-selected={configSubTab === 'automation'}
                  className={`sub-pill-btn ${configSubTab === 'automation' ? 'active' : ''}`}
                  onClick={() => setConfigSubTab('automation')}
                >
                  <Sliders size={14} />
                  <span>Automation</span>
                </button>
                <button
                  role="tab"
                  aria-selected={configSubTab === 'agents'}
                  className={`sub-pill-btn ${configSubTab === 'agents' ? 'active' : ''}`}
                  onClick={() => setConfigSubTab('agents')}
                >
                  <Crosshair size={14} />
                  <span>Agents</span>
                </button>
                <button
                  role="tab"
                  aria-selected={configSubTab === 'chat'}
                  className={`sub-pill-btn ${configSubTab === 'chat' ? 'active' : ''}`}
                  onClick={() => setConfigSubTab('chat')}
                >
                  <MessageSquare size={14} />
                  <span>Chat</span>
                </button>
                <button
                  role="tab"
                  aria-selected={configSubTab === 'voting'}
                  className={`sub-pill-btn ${configSubTab === 'voting' ? 'active' : ''}`}
                  onClick={() => setConfigSubTab('voting')}
                >
                  <Vote size={14} />
                  <span>Voting</span>
                </button>
              </div>

              {/* SUBVIEW 1: AUTOMATION */}
              {configSubTab === 'automation' && (
                <div className="subtab-content">
                  <div className="toggles-grid">
                    <button
                      type="button"
                      className={`toggle-tile ${botConfig.anti_afk_enabled ? 'active' : ''}`}
                      onClick={() => sendAction('toggle_anti_afk')}
                    >
                      <div className="tile-icon-row">
                        <Activity size={18} />
                        <span className="tile-switch"></span>
                      </div>
                      <span className="tile-label">Anti-AFK</span>
                      <span className="tile-sub">Bypass AFK detection</span>
                    </button>

                    <button
                      type="button"
                      className={`toggle-tile ${botConfig.auto_queue_enabled ? 'active' : ''}`}
                      onClick={() => sendAction('toggle_auto_queue')}
                    >
                      <div className="tile-icon-row">
                        <Play size={18} />
                        <span className="tile-switch"></span>
                      </div>
                      <span className="tile-label">Auto Queue</span>
                      <span className="tile-sub">{botConfig.auto_queue_mode || 'Competitive'}</span>
                    </button>

                    <button
                      type="button"
                      className={`toggle-tile ${botConfig.auto_ff_enabled ? 'active' : ''}`}
                      onClick={() => sendAction('toggle_auto_ff')}
                    >
                      <div className="tile-icon-row">
                        <Flame size={18} />
                        <span className="tile-switch"></span>
                      </div>
                      <span className="tile-label">Auto /ff</span>
                      <span className="tile-sub">Surrender votes</span>
                    </button>

                    <button
                      type="button"
                      className={`toggle-tile ${botConfig.auto_kj_turret ? 'active' : ''}`}
                      onClick={() => sendAction('toggle_auto_kj')}
                    >
                      <div className="tile-icon-row">
                        <Crosshair size={18} />
                        <span className="tile-switch"></span>
                      </div>
                      <span className="tile-label">KJ Turret</span>
                      <span className="tile-sub">Auto place in round</span>
                    </button>

                    <button
                      type="button"
                      className={`toggle-tile ${botConfig.auto_reconnect ? 'active' : ''}`}
                      onClick={() => sendAction('toggle_auto_reconnect')}
                    >
                      <div className="tile-icon-row">
                        <RotateCcw size={18} />
                        <span className="tile-switch"></span>
                      </div>
                      <span className="tile-label">Auto Reconnect</span>
                      <span className="tile-sub">Relaunch if crashed</span>
                    </button>

                    <button
                      type="button"
                      className={`toggle-tile ${botConfig.lock_random_agent ? 'active' : ''}`}
                      onClick={() => sendAction('toggle_random_agent')}
                    >
                      <div className="tile-icon-row">
                        <Sparkles size={18} />
                        <span className="tile-switch"></span>
                      </div>
                      <span className="tile-label">Random Agent</span>
                      <span className="tile-sub">Pick from queue</span>
                    </button>
                  </div>
                </div>
              )}

              {/* SUBVIEW 2: AGENTS */}
              {configSubTab === 'agents' && (
                <div className="subtab-content">
                  <div className="card-panel">
                    <div className="panel-row">
                      <div>
                        <span className="panel-title">Instalock Agent</span>
                        <span className="panel-desc">Automatically lock chosen agent on Agent Select</span>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={botConfig.instalock_enabled ?? false}
                          onChange={(e) => updateConfig({ instalock_enabled: e.target.checked })}
                        />
                        <span className="slider round"></span>
                      </label>
                    </div>

                    <div className="panel-row" style={{ marginTop: '14px' }}>
                      <div>
                        <span className="panel-title">Starter Fallback</span>
                        <span className="panel-desc">Pick Starter Agent if primary is unavailable</span>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={botConfig.starter_fallback_enabled ?? false}
                          onChange={(e) => updateConfig({ starter_fallback_enabled: e.target.checked })}
                        />
                        <span className="slider round"></span>
                      </label>
                    </div>

                    <div className="slider-container" style={{ marginTop: '16px' }}>
                      <div className="slider-header">
                        <span className="panel-title">Lock Delay</span>
                        <span className="slider-value tabular-nums">{botConfig.lock_delay ?? 20} ms</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="500"
                        step="10"
                        value={botConfig.lock_delay ?? 20}
                        onChange={(e) => updateConfig({ lock_delay: Number(e.target.value) })}
                        className="mobile-range-slider"
                      />
                    </div>
                  </div>

                  <div className="card-panel" style={{ marginTop: '12px' }}>
                    <div className="agent-picker-header">
                      <span className="panel-title">Selected Agent: <strong style={{ color: '#38bdf8' }}>{selectedAgentName}</strong></span>
                      <input
                        type="text"
                        placeholder="Search agent..."
                        value={agentSearch}
                        onChange={(e) => setAgentSearch(e.target.value)}
                        className="agent-search-input"
                      />
                    </div>

                    <div className="agent-chips-grid">
                      {VALORANT_AGENTS.filter((a) => a.toLowerCase().includes(agentSearch.toLowerCase())).map((ag) => {
                        const isSelected = selectedAgentName.toLowerCase() === ag.toLowerCase();
                        return (
                          <button
                            key={ag}
                            type="button"
                            className={`agent-chip ${isSelected ? 'selected' : ''}`}
                            onClick={() => updateConfig({ selected_agents: [ag] })}
                          >
                            <span className="agent-avatar-mini">{ag.slice(0, 2)}</span>
                            <span className="agent-chip-name">{ag}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* SUBVIEW 3: CHAT */}
              {configSubTab === 'chat' && (
                <div className="subtab-content">
                  <div className="card-panel">
                    <div className="panel-row">
                      <div>
                        <span className="panel-title">Auto Chat Broadcast</span>
                        <span className="panel-desc">Automate periodic in-game message sending</span>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={botConfig.chat_enabled ?? false}
                          onChange={(e) => updateConfig({ chat_enabled: e.target.checked })}
                        />
                        <span className="slider round"></span>
                      </label>
                    </div>

                    <div className="chat-target-selector" style={{ marginTop: '16px' }}>
                      <span className="panel-title">Channel Target</span>
                      <div className="target-btn-group">
                        {['All', 'Team', 'Party'].map((target, idx) => (
                          <button
                            key={target}
                            type="button"
                            className={`target-pill ${(botConfig.chat_target ?? 0) === idx ? 'active' : ''}`}
                            onClick={() => updateConfig({ chat_target: idx })}
                          >
                            {target}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="slider-container" style={{ marginTop: '16px' }}>
                      <div className="slider-header">
                        <span className="panel-title">Interval</span>
                        <span className="slider-value tabular-nums">{botConfig.chat_interval ?? 180}s</span>
                      </div>
                      <input
                        type="range"
                        min="15"
                        max="300"
                        step="15"
                        value={botConfig.chat_interval ?? 180}
                        onChange={(e) => updateConfig({ chat_interval: Number(e.target.value) })}
                        className="mobile-range-slider"
                      />
                    </div>

                    <div className="chat-msg-box" style={{ marginTop: '16px' }}>
                      <span className="panel-title">Message</span>
                      <textarea
                        rows={2}
                        className="chat-textarea"
                        value={botConfig.chat_text || ''}
                        onChange={(e) => updateConfig({ chat_text: e.target.value })}
                        placeholder="Message to send in-game..."
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* SUBVIEW 4: VOTING */}
              {configSubTab === 'voting' && (
                <div className="subtab-content">
                  <div className="card-panel">
                    <div className="panel-row">
                      <div>
                        <span className="panel-title">Auto /ff Surrender</span>
                        <span className="panel-desc">Instantly vote yes and initiate surrender</span>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={botConfig.auto_ff_enabled ?? false}
                          onChange={(e) => updateConfig({ auto_ff_enabled: e.target.checked })}
                        />
                        <span className="slider round"></span>
                      </label>
                    </div>

                    <div className="voting-rounds-section" style={{ marginTop: '16px' }}>
                      <span className="panel-title">Surrender Rounds</span>
                      <div className="voting-rounds-list">
                        <label className="round-checkbox-item">
                          <input
                            type="checkbox"
                            checked={botConfig.auto_ff_round_5 ?? true}
                            onChange={(e) => updateConfig({ auto_ff_round_5: e.target.checked })}
                          />
                          <span>Round 5 (Earliest Unrated/Competitive)</span>
                        </label>
                        <label className="round-checkbox-item">
                          <input
                            type="checkbox"
                            checked={botConfig.auto_ff_round_13 ?? false}
                            onChange={(e) => updateConfig({ auto_ff_round_13: e.target.checked })}
                          />
                          <span>Round 13 (Half-time change)</span>
                        </label>
                        <label className="round-checkbox-item">
                          <input
                            type="checkbox"
                            checked={botConfig.auto_ff_round_14 ?? false}
                            onChange={(e) => updateConfig({ auto_ff_round_14: e.target.checked })}
                          />
                          <span>Round 14 (Overtime vote)</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: TRACKER (ROSTER & SHOP) */}
          {activeTab === 'tracker' && (
            <div className="tab-pane">
              {/* TRACKER SUB-TABS PILL BAR */}
              <div className="sub-pills-bar" role="tablist" aria-label="Tracker Sub-views">
                <button
                  role="tab"
                  aria-selected={trackerSubTab === 'roster'}
                  className={`sub-pill-btn ${trackerSubTab === 'roster' ? 'active' : ''}`}
                  onClick={() => {
                    setTrackerSubTab('roster');
                    sendAction('refresh_roster');
                  }}
                >
                  <Users size={14} />
                  <span>Match Tracker</span>
                </button>
                <button
                  role="tab"
                  aria-selected={trackerSubTab === 'shop'}
                  className={`sub-pill-btn ${trackerSubTab === 'shop' ? 'active' : ''}`}
                  onClick={() => {
                    setTrackerSubTab('shop');
                    sendAction('request_storefront');
                  }}
                >
                  <ShoppingBag size={14} />
                  <span>Daily Shop</span>
                </button>
              </div>

              {/* SUBVIEW 1: MATCH TRACKER */}
              {trackerSubTab === 'roster' && (
                <div className="subtab-content">
                  <div className="roster-view-header">
                    <div>
                      <h3 className="section-title">Live Match Roster</h3>
                      <span className="section-subtitle">Unmasked names, ranks & win rates</span>
                    </div>
                    <button
                      className="icon-btn-refresh"
                      onClick={() => sendAction('refresh_roster')}
                      aria-label="Refresh live match roster"
                    >
                      <RefreshCw size={16} />
                    </button>
                  </div>

                  {roster.length === 0 ? (
                    <div className="empty-state-card">
                      <Users size={36} color="#64748b" />
                      <p>No active match roster detected.</p>
                      <span>Roster populates automatically when you enter Agent Select or In-Game on PC.</span>
                    </div>
                  ) : (
                    <div className="roster-list">
                      {roster.map((player) => (
                        <div key={player.puuid || player.game_name} className={`player-row ${player.team.toLowerCase()}`}>
                          <div className="player-left">
                            <div className="avatar-capsule">
                              <span className="agent-avatar-text">{player.agent_name.slice(0, 2)}</span>
                            </div>
                            <div className="player-meta">
                              <div className="player-name-line">
                                <span className="player-name">{player.game_name}</span>
                                {player.tag_line && <span className="player-tag">#{player.tag_line}</span>}
                              </div>
                              <span className="player-agent-sub">{player.agent_name}</span>
                            </div>
                          </div>

                          <div className="player-right">
                            <span className="player-rank-badge">{player.current_rank_name}</span>
                            <span className="player-winrate-stat tabular-nums">{player.win_rate || '-'}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* SUBVIEW 2: DAILY SHOP */}
              {trackerSubTab === 'shop' && (
                <div className="subtab-content">
                  {/* WALLET BAR */}
                  <div className="wallet-strip">
                    <div className="wallet-chip">
                      <Coins size={14} color="#f59e0b" />
                      <span className="wallet-label">VP</span>
                      <span className="wallet-val tabular-nums">{status?.wallet?.vp?.toLocaleString() ?? '-'}</span>
                    </div>
                    <div className="wallet-chip">
                      <Coins size={14} color="#a855f7" />
                      <span className="wallet-label">RP</span>
                      <span className="wallet-val tabular-nums">{status?.wallet?.rp?.toLocaleString() ?? '-'}</span>
                    </div>
                    <div className="wallet-chip">
                      <Coins size={14} color="#38bdf8" />
                      <span className="wallet-label">KC</span>
                      <span className="wallet-val tabular-nums">{status?.wallet?.kc?.toLocaleString() ?? '-'}</span>
                    </div>
                  </div>

                  <div className="shop-header-row">
                    <div>
                      <h3 className="section-title">Daily Offers</h3>
                      {storefront?.daily_seconds_remaining ? (
                        <span className="shop-timer tabular-nums">
                          Resets in {formatCountdown(storefront.daily_seconds_remaining)}
                        </span>
                      ) : null}
                    </div>
                    <button
                      className="icon-btn-refresh"
                      onClick={() => sendAction('request_storefront')}
                      aria-label="Refresh daily shop"
                    >
                      <RefreshCw size={16} />
                    </button>
                  </div>

                  {!storefront || !storefront.daily_offers || storefront.daily_offers.length === 0 ? (
                    <div className="empty-state-card">
                      <ShoppingBag size={36} color="#64748b" />
                      <p>Storefront not loaded.</p>
                      <span>Tap refresh to fetch your daily skin offers directly from VALORANT.</span>
                      <button
                        className="fetch-shop-btn"
                        onClick={() => sendAction('request_storefront')}
                        style={{ marginTop: '12px' }}
                      >
                        Fetch Daily Shop
                      </button>
                    </div>
                  ) : (
                    <div className="shop-skins-grid">
                      {storefront.daily_offers.map((offer) => (
                        <div key={offer.offer_id} className="skin-card">
                          <div className="skin-img-wrap">
                            {offer.icon_url ? (
                              <img src={offer.icon_url} alt={offer.skin_name} className="skin-img" loading="lazy" />
                            ) : (
                              <div className="skin-img-placeholder">
                                <ShoppingBag size={24} color="#64748b" />
                              </div>
                            )}
                          </div>
                          <div className="skin-info">
                            <span className="skin-name">{offer.skin_name}</span>
                            <div className="skin-price-row">
                              <span className="weapon-type">{offer.weapon_name || 'Weapon Skin'}</span>
                              <div className="price-tag tabular-nums">
                                <span className="vp-currency-mark">VP</span>
                                <span>{offer.cost_vp.toLocaleString()}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* NIGHT MARKET (IF ACTIVE) */}
                  {storefront?.night_market_active && storefront.night_market_offers && storefront.night_market_offers.length > 0 && (
                    <div className="night-market-panel" style={{ marginTop: '20px' }}>
                      <div className="nm-header">
                        <span className="nm-title">Night.Market Offers</span>
                        <span className="nm-timer tabular-nums">
                          {formatCountdown(storefront.night_market_seconds_remaining)}
                        </span>
                      </div>
                      <div className="shop-skins-grid">
                        {storefront.night_market_offers.map((nm) => (
                          <div key={nm.offer_id} className="skin-card nm-card">
                            <div className="skin-img-wrap">
                              {nm.icon_url && <img src={nm.icon_url} alt={nm.skin_name} className="skin-img" />}
                              <span className="nm-discount-badge tabular-nums">-{nm.discount_percent}%</span>
                            </div>
                            <div className="skin-info">
                              <span className="skin-name">{nm.skin_name}</span>
                              <div className="skin-price-row">
                                <span className="orig-price tabular-nums">{nm.original_cost_vp}</span>
                                <div className="price-tag tabular-nums">
                                  <span className="vp-currency-mark">VP</span>
                                  <span>{nm.discounted_cost_vp.toLocaleString()}</span>
                                </div>
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
          )}

          {/* TAB 3: STATUS (SCREENSHOT & DANGER ZONE) */}
          {activeTab === 'status' && (
            <div className="tab-pane">
              {/* STATUS SUB-TABS PILL BAR */}
              <div className="sub-pills-bar" role="tablist" aria-label="Status Sub-views">
                <button
                  role="tab"
                  aria-selected={statusSubTab === 'screenshot'}
                  className={`sub-pill-btn ${statusSubTab === 'screenshot' ? 'active' : ''}`}
                  onClick={() => setStatusSubTab('screenshot')}
                >
                  <Camera size={14} />
                  <span>Screen Capture</span>
                </button>
                <button
                  role="tab"
                  aria-selected={statusSubTab === 'danger'}
                  className={`sub-pill-btn danger ${statusSubTab === 'danger' ? 'active' : ''}`}
                  onClick={() => setStatusSubTab('danger')}
                >
                  <AlertTriangle size={14} />
                  <span>Danger Zone</span>
                </button>
              </div>

              {/* SUBVIEW 1: SCREENSHOT */}
              {statusSubTab === 'screenshot' && (
                <div className="subtab-content">
                  <div className="screenshot-toolbar">
                    <button
                      className="capture-now-btn"
                      disabled={isCapturingScreenshot}
                      onClick={() => {
                        setIsCapturingScreenshot(true);
                        sendAction('take_screenshot');
                      }}
                    >
                      <Camera size={16} />
                      <span>{isCapturingScreenshot ? 'Capturing...' : 'Capture Game Screen'}</span>
                    </button>
                  </div>

                  {screenshotUrl ? (
                    <div className="screenshot-display-card">
                      <img src={screenshotUrl} alt="VALORANT Screen Capture" className="captured-screen-img" />
                    </div>
                  ) : (
                    <div className="empty-state-card">
                      <Camera size={44} color="#64748b" />
                      <p>No screenshot captured yet.</p>
                      <span>Tap Capture Game Screen to take a real-time full snapshot of VALORANT on PC.</span>
                    </div>
                  )}
                </div>
              )}

              {/* SUBVIEW 2: DANGER ZONE */}
              {statusSubTab === 'danger' && (
                <div className="subtab-content">
                  <div className="danger-zone-container">
                    <div className="danger-header">
                      <AlertTriangle size={20} color="#ef4444" />
                      <div>
                        <h3 className="danger-title">Danger Zone</h3>
                        <p className="danger-subtitle">High-impact system actions on PC & Remote</p>
                      </div>
                    </div>

                    <div className="danger-actions-list">
                      <div className="danger-action-row">
                        <div className="danger-meta">
                          <span className="action-name">Kill VALORANT</span>
                          <span className="action-desc">Force close VALORANT and Riot Client instantly on PC</span>
                        </div>
                        <button
                          className="danger-btn-red"
                          onClick={() => setShowKillConfirm(true)}
                        >
                          <Skull size={16} />
                          <span>Kill VALORANT</span>
                        </button>
                      </div>

                      <div className="danger-action-row">
                        <div className="danger-meta">
                          <span className="action-name">Logout &amp; Disconnect</span>
                          <span className="action-desc">Unpair this mobile device and clear saved room code</span>
                        </div>
                        <button
                          className="danger-btn-outline"
                          onClick={handleDisconnect}
                        >
                          <LogOut size={16} />
                          <span>Logout</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      )}

      {/* BOTTOM NAVIGATION BAR: EXACTLY 3 PRIMARY TABS */}
      {isConnected && (
        <nav className="mobile-nav" aria-label="Bottom Navigation">
          <button
            className={`nav-tab-item ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
            aria-selected={activeTab === 'config'}
          >
            <Sliders size={20} />
            <span>Config</span>
          </button>

          <button
            className={`nav-tab-item ${activeTab === 'tracker' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('tracker');
              if (trackerSubTab === 'roster') sendAction('refresh_roster');
              else sendAction('request_storefront');
            }}
            aria-selected={activeTab === 'tracker'}
          >
            <Users size={20} />
            <span>Tracker</span>
          </button>

          <button
            className={`nav-tab-item ${activeTab === 'status' ? 'active' : ''}`}
            onClick={() => setActiveTab('status')}
            aria-selected={activeTab === 'status'}
          >
            <Activity size={20} />
            <span>Status</span>
          </button>
        </nav>
      )}
    </div>
  );
}

export default App;
