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
  server_name?: string;
  rank_name: string;
  rank_tier: number;
  wallet?: {
    vp: number;
    rp: number;
    kc: number;
    agent_tokens?: number;
  };
}

export interface TrackedPlayer {
  puuid: string;
  name: string;
  team: string; // "Blue" | "Red"
  agent_id: string;
  agent_name: string;
  level: number;
  current_rank_name: string;
  current_rr: number;
  peak_rank_name: string;
  win_rate: number;
  total_games: number;
  party_tag?: string;
  is_self?: boolean;
  kd_ratio?: number;
}

export interface LiveMatchRoster {
  state: string; // "COREGAME" | "PREGAME" | "CONCLUDED" | "NO_MATCH"
  match_id: string;
  map_name: string;
  gamemode: string;
  server_name?: string;
  ally_team: TrackedPlayer[];
  enemy_team: TrackedPlayer[];
}

export interface StoreDailyOffer {
  offer_id: string;
  skin_name: string;
  weapon_name: string;
  icon_url: string;
  cost_vp: number;
}

export interface StoreFeaturedBundle {
  bundle_id: string;
  name: string;
  display_icon: string;
  total_cost_vp: number;
  seconds_remaining: number;
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

export interface StoreAccessoryOffer {
  offer_id: string;
  item_id: string;
  name: string;
  item_type: string;
  icon_url: string;
  cost_kc: number;
}

export interface StorefrontData {
  daily_offers: StoreDailyOffer[];
  daily_seconds_remaining: number;
  featured_bundles: StoreFeaturedBundle[];
  night_market_active?: boolean;
  night_market_offers?: StoreNightMarketOffer[];
  night_market_seconds_remaining?: number;
  accessory_offers?: StoreAccessoryOffer[];
  accessory_seconds_remaining?: number;
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
  | "roster"
  | "screenshot"
  | "log"
  | "toast"
  | "action_ack"
  | "storefront"
  | "notification"
  | "pair_approved"
  | "pair_denied"
  | "approval_required"
  | "invalid_code"
  | "force_logout";
  payload?: any;
  message?: string;
  token?: string;
  client_id?: string;
  device_name?: string;
  status?: MobileClientStatus;
  bot_running?: boolean;
  roster?: LiveMatchRoster;
  storefront?: StorefrontData;
  logs?: string[];
}
