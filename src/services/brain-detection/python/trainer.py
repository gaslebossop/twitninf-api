import pandas as pd
import numpy as np
import xgboost as xgb
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, accuracy_score
import joblib
import json
import os

# Configuration
HUMAN_DATA = os.path.join(os.path.dirname(__file__), 'human_data.json')
BOT_DATA = os.path.join(os.path.dirname(__file__), 'bot_data.json')
MODEL_OUTPUT = os.path.join(os.path.dirname(__file__), 'bot_brain.joblib')

# ─── FEATURE ENGINEERING ────────────────────────────────────────────────────────

def calculate_avg_tap_duration(actions):
    tap_actions = [a.get('duration_ms', 0) for a in actions if a['action_type'] == 'tap_gesture']
    if not tap_actions: return 0.3 # 150ms normalized
    return min(np.mean(tap_actions) / 500, 1.0)

def calculate_motion_variance(actions):
    motion = [a.get('context_data', {}).get('variance', 0) for a in actions if a['action_type'] == 'device_motion_noise']
    if not motion: return 0.05
    return min(np.mean(motion) * 10, 1.0)

def calculate_typing_entropy(actions):
    delays = []
    for a in actions:
        if a['action_type'] == 'keyboard_rhythm':
            delays.extend(a.get('context_data', {}).get('delays', []))
    if len(delays) < 2: return 0.5
    avg = np.mean(delays)
    std = np.std(delays)
    return min(std / (avg + 1), 1.0)

def calculate_scroll_jitter(actions):
    jitters = [a.get('context_data', {}).get('jitter', 0) for a in actions if a['action_type'] == 'scroll_jitter']
    if not jitters: return 0.1
    return min(np.mean(jitters), 1.0)

def calculate_ip_ratio(actions):
    ips = [a.get('ip_address') for a in actions if a.get('ip_address')]
    if not ips: return 0.1
    return len(set(ips)) / len(actions)

def calculate_fp_stability(actions):
    fps = []
    for a in actions:
        info = a.get('device_info', {})
        if info: fps.append(f"{info.get('os')}-{info.get('model')}")
    if not fps: return 1.0
    return 1.0 if len(set(fps)) <= 1 else 0.0

def calculate_battery_chaos(actions):
    levels = [a.get('context_data', {}).get('battery_level') for a in actions if a.get('context_data', {}).get('battery_level') is not None]
    if len(levels) < 5: return 0.5
    diffs = np.abs(np.diff(levels))
    return len(set(diffs)) / len(levels)

def calculate_transition_entropy(actions):
    """Entropie des transitions : plus c'est varie, plus c'est humain."""
    if len(actions) < 2: return 0.5
    transitions = []
    for i in range(len(actions) - 1):
        transitions.append(f"{actions[i]['action_type']}->{actions[i+1]['action_type']}")
    unique = len(set(transitions))
    return unique / len(transitions)

def calculate_orphan_like_ratio(actions):
    """% de likes sur des cibles jamais vues avant.
    Un humain view TOUJOURS avant de liker. Un bot like a l'aveugle."""
    viewed_targets = set()
    total_likes = 0
    orphan_likes = 0
    
    for a in actions:
        if a['action_type'] == 'tweet_view':
            viewed_targets.add(a['target_id'])
        elif a['action_type'] == 'tweet_like':
            total_likes += 1
            if a['target_id'] not in viewed_targets:
                orphan_likes += 1
    
    if total_likes == 0: return 0.0
    return orphan_likes / total_likes

def calculate_max_like_streak(actions):
    """Plus longue serie consecutive de likes sans autre action.
    Un humain ne fait jamais 10 likes d'affilee sans rien d'autre."""
    max_streak = 0
    current_streak = 0
    for a in actions:
        if a['action_type'] == 'tweet_like':
            current_streak += 1
            max_streak = max(max_streak, current_streak)
        else:
            current_streak = 0
    return max_streak

def calculate_target_diversity(actions):
    """Diversite des cibles : nombre de cibles uniques / total actions.
    Les bots spray frappent toujours des cibles differentes sans repetition."""
    targets = [a['target_id'] for a in actions]
    if len(targets) == 0: return 0.0
    return len(set(targets)) / len(targets)

def calculate_burst_score(delays):
    """Detecte les micro-rafales : % d'actions avec delai < 500ms.
    Les click-farms font des bursts rapides puis des pauses."""
    if len(delays) == 0: return 0.0
    fast_actions = sum(1 for d in delays if d < 500)
    return fast_actions / len(delays)

# ─── EXTRACTION DE FENETRES ─────────────────────────────────────────────────────

def extract_windows(data, label, window_size=50, step=10):
    """Decoupe les donnees en fenetres glissantes avec 10 features."""
    windows = []
    df = pd.DataFrame(data)
    
    for user_id, group in df.groupby('user_id'):
        group = group.sort_values('timestamp')
        actions = group.to_dict('records')
        
        for i in range(0, len(actions) - window_size + 1, step):
            win = actions[i:i+window_size]
            
            # Helper local pour utiliser les fonctions globales
            class FeatureHelper:
                calculate_avg_tap_duration = staticmethod(calculate_avg_tap_duration)
                calculate_motion_variance = staticmethod(calculate_motion_variance)
                calculate_typing_entropy = staticmethod(calculate_typing_entropy)
                calculate_scroll_jitter = staticmethod(calculate_scroll_jitter)
                calculate_ip_ratio = staticmethod(calculate_ip_ratio)
                calculate_fp_stability = staticmethod(calculate_fp_stability)
                calculate_battery_chaos = staticmethod(calculate_battery_chaos)
            
            fh = FeatureHelper()
            
            # Timestamps et delais
            timestamps = [pd.to_datetime(a['timestamp']).timestamp() * 1000 for a in win]
            delays = np.diff(timestamps)
            delays = delays[delays > 0]
            
            if len(delays) < 5: continue
            
            avg_delay = np.mean(delays)
            std_delay = np.std(delays)
            regularity = std_delay / avg_delay if avg_delay > 0 else 1
            
            # Features classiques
            trans_entropy = calculate_transition_entropy(win)
            unique_actions = len(set([a['action_type'] for a in win]))
            
            # NOUVELLES FEATURES CONTEXTUELLES
            orphan_ratio = calculate_orphan_like_ratio(win)
            max_streak = calculate_max_like_streak(win)
            target_div = calculate_target_diversity(win)
            burst = calculate_burst_score(delays.tolist())
            
            windows.append({
                'avg_delay': min(avg_delay / 10000, 1.0),
                'regularity': min(regularity, 1.0),
                'engagement_ratio': len([a for a in win if 'like' in a['action_type']]) / window_size,
                'human_signal_ratio': len([a for a in win if 'scroll' in a['action_type'] or 'time_spent' in a['action_type']]) / window_size,
                'entropy': trans_entropy,
                'unique_actions_ratio': unique_actions / 5.0,
                'intensity': min(window_size / (max(timestamps) - min(timestamps) + 1) * 1000, 1.0),
                'orphan_like_ratio': orphan_ratio,
                'max_like_streak': min(max_streak / window_size, 1.0),
                'target_diversity': target_div,
                'burst_score': burst,
                
                # --- V5: Human Precision ---
                'avg_tap_duration': calculate_avg_tap_duration(win),
                'motion_variance': calculate_motion_variance(win),
                'typing_speed_entropy': calculate_typing_entropy(win),
                'scroll_jitter_score': calculate_scroll_jitter(win),
                
                # --- V6: Environment ---
                'unique_ip_ratio': calculate_ip_ratio(win),
                'fingerprint_stability': calculate_fp_stability(win),
                'battery_chaos': calculate_battery_chaos(win),
                
                'label': label
            })
    return windows

# ─── ENTRAINEMENT ───────────────────────────────────────────────────────────────

def train():
    print("[DATA] Chargement et preparation des donnees...")
    with open(HUMAN_DATA, 'r') as f: human_raw = json.load(f)
    with open(BOT_DATA, 'r') as f: bot_raw = json.load(f)
    
    human_wins = extract_windows(human_raw, 0)
    bot_wins = extract_windows(bot_raw, 1)
    
    print(f"[STATS] Fenetres : Humains={len(human_wins)}, Bots={len(bot_wins)}")
    
    # BALANCING 50/50
    min_size = min(len(human_wins), len(bot_wins))
    np.random.shuffle(human_wins)
    np.random.shuffle(bot_wins)
    
    balanced_data = human_wins[:min_size] + bot_wins[:min_size]
    df = pd.DataFrame(balanced_data)
    
    print(f"--- Dataset : {min_size*2} echantillons (50/50)")
    
    X = df.drop('label', axis=1)
    y = df['label']
    
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    
    print("[TRAIN] XGBoost v22.0 (Contextual Beast)...")
    model = xgb.XGBClassifier(
        n_estimators=500,
        max_depth=8,
        learning_rate=0.01,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=0.1,
        reg_lambda=1.0,
        use_label_encoder=False,
        eval_metric='logloss'
    )
    
    model.fit(X_train, y_train)
    
    y_pred = model.predict(X_test)
    print("\n--- RAPPORT DE PERFORMANCE ---")
    print(classification_report(y_test, y_pred))
    print(f"Accuracy: {accuracy_score(y_test, y_pred) * 100:.2f}%")
    
    # Importance des features
    features = X.columns
    importances = model.feature_importances_
    indices = np.argsort(importances)[::-1]
    
    print("\n--- IMPORTANCE DES FEATURES ---")
    for f in range(X.shape[1]):
        print(f"{f+1}. {features[indices[f]]:<22} : {importances[indices[f]]:.4f}")
    
    joblib.dump(model, MODEL_OUTPUT)
    print(f"\n[OK] Modele sauvegarde : {MODEL_OUTPUT}")

if __name__ == "__main__":
    train()
