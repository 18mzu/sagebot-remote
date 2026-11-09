import { useState, useEffect, useRef } from 'react';
import {
  Shield,
  WifiOff,
  Power,
  Camera,
  Play,
  RotateCcw,
  Crosshair,
  Users,
  Activity,
  Sparkles,
  RefreshCw,
  Radio,
  Sliders,
  AlertTriangle,
  Flame,
} from 'lucide-react';
import { RemoteBridge } from './remoteBridge';
import type { MobileClientStatus, MobileBotConfig, PlayerRosterItem, RemoteMessage } from './types';
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
  });
  const [roster, setRoster] = useState<PlayerRosterItem[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Active view tab
  const [activeTab, setActiveTab] = useState<'status' | 'roster' | 'screenshot'>('status');

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

  // Auto show toast helper
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3200);
  };

  // Connect to PC over Dual-Broker WSS Bridge
  const connectToPC = (targetRoom: string) => {
    const cleanRoom = targetRoom.trim().toUpperCase();
    if (!cleanRoom || cleanRoom.length < 4) {
      setConnectionError('Please enter a valid 6-digit room code');
      return;
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
        // Immediately request sync and poll until PC responds
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
          case 'screenshot':
            setScreenshotUrl(msg.payload);
            setIsCapturingScreenshot(false);
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
          `Waiting for SageBot PC (${cleanRoom})... Make sure SageBot is open on your PC and the 6-digit code matches.`
        );
      }
    }, 8000);
  };

  // Send control action to PC
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

  // Auto connect if roomCode was stored or passed via QR URL
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
    localStorage.removeItem('sagebot_room_code');
    setRoomCode('');
  };

  // Map state badge colors
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

  return (
    <div className="mobile-shell">
      {/* Toast Notification */}
      {toastMessage && (
        <div className="mobile-toast">
          <Sparkles size={16} className="toast-icon" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* HEADER BAR */}
      <header className="mobile-header">
        <div className="header-brand">
          <div className="app-icon-circle">
            <Shield size={18} color="#38bdf8" />
          </div>
          <div>
            <div className="app-name-row">
              <span className="app-title">SageBot</span>
              <span className="remote-pill">REMOTE</span>
            </div>
            <div className="connection-subtext">
              {isConnected ? (
                <span className="conn-status online">
                  <span className="status-dot green"></span>
                  PC Connected • {roomCode.toUpperCase()}
                </span>
              ) : isConnecting ? (
                <span className="conn-status connecting">
                  <span className="status-dot amber"></span>
                  Connecting...
                </span>
              ) : (
                <span className="conn-status offline">
                  <span className="status-dot red"></span>
                  Disconnected
                </span>
              )}
            </div>
          </div>
        </div>

        {isConnected ? (
          <button className="icon-btn-header" onClick={handleDisconnect} aria-label="Disconnect">
            <WifiOff size={18} color="#94a3b8" />
          </button>
        ) : (
          <button className="icon-btn-header" onClick={() => connectToPC(pinInput || roomCode)} aria-label="Reconnect">
            <RefreshCw size={18} color="#38bdf8" />
          </button>
        )}
      </header>

      {/* PAIRING OVERLAY (IF NOT CONNECTED) */}
      {!isConnected && (
        <main className="mobile-body pairing-body">
          <div className="pairing-card">
            <div className="pairing-header">
              <div className="icon-pairing-badge">
                <Radio size={28} color="#38bdf8" />
              </div>
              <h2 className="pairing-title">Pair with SageBot PC</h2>
              <p className="pairing-desc">
                Open SageBot on your PC, go to <strong>Mobile Remote</strong>, and enter the 6-digit room code.
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
              <div className="error-callout">
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

      {/* CONNECTED MAIN DASHBOARD */}
      {isConnected && (
        <main className="mobile-body">
          {/* TAB 1: STATUS DASHBOARD */}
          {activeTab === 'status' && (
            <div className="tab-pane">
              {/* PRIMARY MATCH STATUS SURFACE */}
              <div className="status-surface">
                <div className="surface-top">
                  <span
                    className="state-badge"
                    style={{ color: badge.color, backgroundColor: badge.bg }}
                  >
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
                    <span className="map-name-display">{status?.map_name && status.map_name !== '-' ? status.map_name : 'No Active Match'}</span>
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
                    <span className="slot-title">BOT POWER</span>
                    <span className={`slot-value ${botConfig.bot_running ? 'online' : 'offline'}`}>
                      {botConfig.bot_running ? 'ACTIVE' : 'STOPPED'}
                    </span>
                  </div>
                </div>
              </div>

              {/* QUICK ACTION BUTTONS */}
              <div className="quick-actions-bar">
                <button
                  className={`primary-power-btn ${botConfig.bot_running ? 'running' : 'stopped'}`}
                  onClick={() => sendAction('toggle_bot')}
                >
                  <Power size={20} />
                  <span>{botConfig.bot_running ? 'STOP BOT' : 'START BOT'}</span>
                </button>

                <button
                  className="quick-tool-btn"
                  onClick={() => {
                    setIsCapturingScreenshot(true);
                    sendAction('take_screenshot');
                    setActiveTab('screenshot');
                  }}
                >
                  <Camera size={18} />
                  <span>Screenshot</span>
                </button>
              </div>

              {/* BOT AUTOMATION LIVE TOGGLES */}
              <div className="control-section-header">
                <Sliders size={16} color="#38bdf8" />
                <span>Live Automation Toggles</span>
              </div>

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

          {/* TAB 2: LIVE ROSTER TRACKER */}
          {activeTab === 'roster' && (
            <div className="tab-pane">
              <div className="roster-view-header">
                <div>
                  <h3 className="section-title">Match Roster</h3>
                  <span className="section-subtitle">Real ranks, unmasked identities & K/D rates</span>
                </div>
                <button className="icon-btn-refresh" onClick={() => sendAction('refresh_roster')} aria-label="Refresh roster">
                  <RefreshCw size={16} />
                </button>
              </div>

              {roster.length === 0 ? (
                <div className="empty-roster-state">
                  <Users size={36} color="#64748b" />
                  <p>No active match roster detected.</p>
                  <span>Roster populates automatically upon entering Agent Select or In-Game.</span>
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

          {/* TAB 3: SCREENSHOT VIEW */}
          {activeTab === 'screenshot' && (
            <div className="tab-pane screenshot-pane">
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
                <div className="empty-screenshot-state">
                  <Camera size={44} color="#64748b" />
                  <p>No screenshot captured yet.</p>
                  <span>Tap Capture Game Screen to take a real-time snapshot of your PC's VALORANT window.</span>
                </div>
              )}
            </div>
          )}
        </main>
      )}

      {/* BOTTOM NAVIGATION BAR */}
      {isConnected && (
        <nav className="mobile-nav">
          <button
            className={`nav-tab-item ${activeTab === 'status' ? 'active' : ''}`}
            onClick={() => setActiveTab('status')}
          >
            <Activity size={20} />
            <span>Status</span>
          </button>

          <button
            className={`nav-tab-item ${activeTab === 'roster' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('roster');
              sendAction('refresh_roster');
            }}
          >
            <Users size={20} />
            <span>Roster</span>
          </button>

          <button
            className={`nav-tab-item ${activeTab === 'screenshot' ? 'active' : ''}`}
            onClick={() => setActiveTab('screenshot')}
          >
            <Camera size={20} />
            <span>Screen</span>
          </button>
        </nav>
      )}
    </div>
  );
}

export default App;
