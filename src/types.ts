export interface MobileClientStatus {
  is_connected: boolean;
  game_live: boolean;
  match_state: string; // "In Game" | "Agent Select" | "In Queue" | "In Lobby" | "OFFLINE"
  map_name: string;
  gamemode: string;
  current_agent: string;
  score_ally: number;
  score_enemy: number;
  player_name?: string;
  player_tag?: string;
  rank_name: string;
  rank_tier: number;
  wallet?: {
    vp: number;
    rp: number;
    kc: number;
  };
}

export interface PlayerRosterItem {
  puuid: string;
  game_name: string;
  tag_line: string;
  team: string; // "Blue" | "Red"
  agent_name: string;
  agent_id: string;
  current_rank_name: string;
  current_rr: number;
  win_rate: string;
  games_count: number;
  is_party: boolean;
  party_color?: string;
}

export interface MobileBotConfig {
  bot_running: boolean;
  anti_afk_enabled: boolean;
  auto_reconnect: boolean;
  auto_ff_enabled: boolean;
  auto_kj_turret: boolean;
  auto_queue_enabled: boolean;
  auto_queue_mode: string;
  lock_random_agent: boolean;
  low_detail: boolean;
}

export interface RemoteMessage {
  type: "sync" | "status" | "config" | "roster" | "screenshot" | "log" | "toast" | "action_ack";
  payload?: any;
  status?: MobileClientStatus;
  config?: MobileBotConfig;
  roster?: PlayerRosterItem[];
}
