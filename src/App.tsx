import { useState, useEffect, useRef } from 'react';
import {
  Shield,
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
  Coins,
  Clock,
  Terminal,
  ClipboardPaste,
  Check,
} from 'lucide-react';
import { RemoteBridge } from './remoteBridge';
import type {
  MobileClientStatus,
  LiveMatchRoster,
  TrackedPlayer,
  StorefrontData,
  RemoteNotification,
  RemoteMessage,
} from './types';
import './App.css';

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

  // Exactly 4 primary footer tabs: 'status' | 'tracker' | 'shop' | 'settings'
  const [activeTab, setActiveTab] = useState<'status' | 'tracker' | 'shop' | 'settings'>('status');

  // Status & live data verified from PC
  const [status, setStatus] = useState<MobileClientStatus | null>(null);
  const [botRunning, setBotRunning] = useState<boolean>(false);
  const [roster, setRoster] = useState<LiveMatchRoster | null>(null);
  const [storefront, setStorefront] = useState<StorefrontData | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState<boolean>(false);

  // Notifications & Modals
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [incomingNotification, setIncomingNotification] = useState<RemoteNotification | null>(null);
  const [showKillConfirm, setShowKillConfirm] = useState<boolean>(false);
  const [hasNotifPermission, setHasNotifPermission] = useState<boolean>(() => {
    return typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted';
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

  // Trigger Native OS push notification (iOS Home Screen PWA & Android)
  const triggerNativeNotification = (title: string, body: string, tag: string) => {
    // 1. Send to Service Worker for background system lockscreen notification
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SHOW_NOTIFICATION',
        title,
        body,
        tag,
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, {
          body,
          icon: '/icon-192.png',
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
    setIncomingNotification(notif);
    triggerNativeNotification(notif.title, notif.message, notif.eventType);

    setTimeout(() => {
      setIncomingNotification((prev) => (prev?.timestamp === notif.timestamp ? null : prev));
    }, 5500);
  };

  // Connect to PC over Dual-Broker WSS Bridge
  const connectToPC = (targetRoom: string) => {
    const cleanRoom = targetRoom.trim().toUpperCase();
    if (!cleanRoom || cleanRoom.length < 4) {
      setConnectionError('Please enter your 6-digit room code');
      return;
    }

    // Request notification permission smoothly upon connection
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        setHasNotifPermission(perm === 'granted');
      }).catch(() => {});
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
            if (typeof msg.bot_running === 'boolean') setBotRunning(msg.bot_running);
            if (msg.roster) setRoster(msg.roster);
            if (msg.storefront) setStorefront(msg.storefront);
            if (msg.logs) setLogs(msg.logs);
            break;
          case 'status':
            setStatus(msg.payload);
            break;
          case 'roster':
            setRoster(msg.payload || null);
            break;
          case 'storefront':
            setStorefront(msg.payload || null);
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
          `Waiting for SageBot PC (${cleanRoom})... Ensure SageBot is running on your PC with Mobile Remote open.`
        );
      }
    }, 8000);
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
    setRoster(null);
    setStorefront(null);
    setScreenshotUrl(null);
    setLogs([]);
    localStorage.removeItem('sagebot_room_code');
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
        triggerNativeNotification('SageBot v4.0', 'Notifications active on your device.', 'setup');
      } else {
        showToast('Notification permission blocked.');
      }
    }
  };

  // State badge styling
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

  const formatCountdown = (secs?: number) => {
    if (!secs || secs <= 0) return '00:00:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="mobile-shell">
      {/* PUSH NOTIFICATION BANNER */}
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

      {/* TOP HEADER BAR: CLEAN SAGEBOT TITLE & STATUS PILL */}
      <header className="mobile-header">
        <div className="header-brand-clean">
          <div className="brand-logo-circle">
            <Shield size={18} color="#38bdf8" />
          </div>
          <span className="clean-app-title">SageBot</span>
        </div>

        <div className="header-status-slot">
          {isConnected ? (
            <span className="conn-badge online">
              <span className="dot green"></span>
              Online
            </span>
          ) : isConnecting ? (
            <span className="conn-badge connecting">
              <span className="dot amber"></span>
              Connecting
            </span>
          ) : (
            <span className="conn-badge offline">
              <span className="dot red"></span>
              Offline
            </span>
          )}
        </div>
      </header>

      {/* PAIRING VIEW (NOT CONNECTED) */}
      {!isConnected && (
        <main className="mobile-body pairing-body">
          <div className="sleek-pairing-card">
            <div className="pairing-hero-icon">
              <Shield size={32} color="#38bdf8" />
            </div>

            <h2 className="pairing-main-title">Pair with SageBot PC</h2>
            <p className="pairing-main-desc">
              Enter the 6-digit room code from your PC’s <strong>Mobile Remote</strong> tab.
            </p>

            <div className="code-input-container">
              <div className="input-with-paste">
                <input
                  type="text"
                  maxLength={6}
                  placeholder="000000"
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
                {isConnecting ? 'Connecting to PC...' : 'Connect to PC'}
              </button>
            </div>

            {connectionError && (
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
          {/* TAB 1: STATUS (LIVE INGAME, SCREENSHOT, MINIMAL LOGS) */}
          {activeTab === 'status' && (
            <div className="tab-pane">
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
                    <span className="stat-label">BOT</span>
                    <span className={`stat-val ${botRunning ? 'online' : 'offline'}`}>
                      {botRunning ? 'ACTIVE' : 'STOPPED'}
                    </span>
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

          {/* TAB 2: TRACKER (FULL VERIFIED ROSTER FROM PC) */}
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

                {!roster || (roster.ally_team.length === 0 && roster.enemy_team.length === 0) ? (
                  <div className="empty-sub-state">
                    <Users size={36} color="#64748b" />
                    <p>No active match roster detected.</p>
                    <span>Populates automatically when you enter Agent Select or In-Game on PC.</span>
                  </div>
                ) : (
                  <div className="teams-scroll-container">
                    {/* ALLY TEAM */}
                    <div className="team-block ally-team">
                      <span className="team-block-title ally">ALLY TEAM</span>
                      <div className="players-list">
                        {roster.ally_team.map((player: TrackedPlayer) => (
                          <div key={player.puuid || player.name} className="roster-player-card ally">
                            <div className="player-agent-col">
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
                                  <span>{player.agent_name.slice(0, 2)}</span>
                                </div>
                              )}
                            </div>

                            <div className="player-info-col">
                              <div className="player-name-row">
                                <span className="player-display-name">{player.name}</span>
                                {player.is_self && <span className="self-tag">YOU</span>}
                                {player.party_tag && <span className="party-tag">{player.party_tag}</span>}
                              </div>
                              <span className="player-agent-name">{player.agent_name || 'Agent'}</span>
                            </div>

                            <div className="player-stats-col">
                              <span className="player-rank-title">{player.current_rank_name || 'Unranked'}</span>
                              <div className="stats-sub-row tabular-nums">
                                <span className="player-wr">{player.win_rate ? `${Math.round(player.win_rate)}%` : '-'}</span>
                                {player.kd_ratio && <span className="player-kd">{player.kd_ratio.toFixed(2)} KD</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* ENEMY TEAM */}
                    {roster.enemy_team.length > 0 && (
                      <div className="team-block enemy-team" style={{ marginTop: '16px' }}>
                        <span className="team-block-title enemy">ENEMY TEAM</span>
                        <div className="players-list">
                          {roster.enemy_team.map((player: TrackedPlayer) => (
                            <div key={player.puuid || player.name} className="roster-player-card enemy">
                              <div className="player-agent-col">
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
                                    <span>{player.agent_name.slice(0, 2)}</span>
                                  </div>
                                )}
                              </div>

                              <div className="player-info-col">
                                <div className="player-name-row">
                                  <span className="player-display-name">{player.name}</span>
                                  {player.party_tag && <span className="party-tag">{player.party_tag}</span>}
                                </div>
                                <span className="player-agent-name">{player.agent_name || 'Agent'}</span>
                              </div>

                              <div className="player-stats-col">
                                <span className="player-rank-title">{player.current_rank_name || 'Unranked'}</span>
                                <div className="stats-sub-row tabular-nums">
                                  <span className="player-wr">{player.win_rate ? `${Math.round(player.win_rate)}%` : '-'}</span>
                                  {player.kd_ratio && <span className="player-kd">{player.kd_ratio.toFixed(2)} KD</span>}
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

          {/* TAB 3: SHOP (FULL CONTENT: WALLET, FEATURED BUNDLE, DAILY OFFERS, NIGHT MARKET, ACCESSORY) */}
          {activeTab === 'shop' && (
            <div className="tab-pane">
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

              {/* SHOP CONTENT CONTAINER */}
              <div className="surface-card">
                <div className="surface-card-header">
                  <div>
                    <h3 className="card-heading">Shop</h3>
                    {storefront?.daily_seconds_remaining ? (
                      <span className="shop-countdown tabular-nums">
                        Resets in {formatCountdown(storefront.daily_seconds_remaining)}
                      </span>
                    ) : (
                      <span className="card-subheading">Storefront</span>
                    )}
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
                                  <Clock size={12} /> {formatCountdown(bundle.seconds_remaining)}
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
                        <span className="shop-subheading">DAILY OFFERS</span>
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
                            {formatCountdown(storefront.night_market_seconds_remaining)}
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

          {/* TAB 4: SETTINGS (VERSION, NOTIFICATIONS, KILL VALORANT, LOGOUT) */}
          {activeTab === 'settings' && (
            <div className="tab-pane">
              {/* VERSION CARD */}
              <div className="surface-card version-card">
                <div className="version-info-row">
                  <div className="version-brand">
                    <Shield size={22} color="#38bdf8" />
                    <div>
                      <h3 className="version-title">SageBot</h3>
                      <span className="version-badge">v4.0</span>
                    </div>
                  </div>
                  <span className="room-label-tag tabular-nums">Room #{roomCode}</span>
                </div>
                <p className="version-desc">
                  Remote control & live match companion for SageBot PC.
                </p>
              </div>

              {/* NOTIFICATION STATUS CARD */}
              <div className="surface-card">
                <div className="setting-action-row">
                  <div className="setting-meta">
                    <span className="setting-name">Phone Push Notifications</span>
                    <span className="setting-desc">
                      {hasNotifPermission
                        ? 'Active — alerts will ring on match start & disconnect.'
                        : 'Enable to receive lockscreen alerts on iOS & Android.'}
                    </span>
                  </div>
                  {!hasNotifPermission && (
                    <button className="enable-notif-btn" onClick={requestNotificationPermission}>
                      <Bell size={14} />
                      <span>Enable</span>
                    </button>
                  )}
                  {hasNotifPermission && (
                    <span className="notif-active-badge">
                      <Check size={14} /> Active
                    </span>
                  )}
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
