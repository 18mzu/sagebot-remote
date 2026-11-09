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

export interface StoreDailyOffer {
  offer_id: string;
  skin_name: string;
  weapon_name: string;
  icon_url: string;
  cost_vp: number;
}

export interface StoreNightMarketOffer {
  offer_id: string;
  skin_name: string;
  weapon_name: string;
  icon_url: string;
  original_cost_vp: number;
  discounted_cost_vp: number;
  discount_percent: number;
  is_seen: boolean;
}

export interface StorefrontData {
  daily_offers: StoreDailyOffer[];
  daily_seconds_remaining: number;
  night_market_active?: boolean;
  night_market_offers?: StoreNightMarketOffer[];
  night_market_seconds_remaining?: number;
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
  // Agents sub-config
  agents_enabled?: boolean;
  instalock_enabled?: boolean;
  lock_delay?: number;
  starter_fallback_enabled?: boolean;
  selected_agents?: string[];
  // Chat sub-config
  chat_enabled?: boolean;
  chat_target?: number; // 0 = All, 1 = Team, 2 = Party
  chat_interval?: number;
  chat_text?: string;
  // Voting sub-config
  auto_ff_round_5?: boolean;
  auto_ff_round_13?: boolean;
  auto_ff_round_14?: boolean;
  // Notifications
  remote_notify_disconnect?: boolean;
  remote_notify_status?: boolean;
  remote_notify_rank_change?: boolean;
}

export interface RemoteNotification {
  title: string;
  message: string;
  eventType: string;
  timestamp: number;
}

export interface RemoteMessage {
  type:
    | "sync"
    | "status"
    | "config"
    | "roster"
    | "screenshot"
    | "log"
    | "toast"
    | "action_ack"
    | "storefront"
    | "notification";
  payload?: any;
  status?: MobileClientStatus;
  config?: MobileBotConfig;
  roster?: PlayerRosterItem[];
}
