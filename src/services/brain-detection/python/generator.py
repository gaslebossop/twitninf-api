import json
import random
import uuid
import os
from datetime import datetime, timedelta

# Configuration
VERSION = "22.0 (Contextual Beast)"
HUMAN_FILE = os.path.join(os.path.dirname(__file__), 'human_data.json')
BOT_FILE = os.path.join(os.path.dirname(__file__), 'bot_data.json')
NUM_SESSIONS_PER_SIDE = 500

# ─── HELPERS ────────────────────────────────────────────────────────────────────

ALL_TYPES = ['tweet_view', 'scroll_50', 'time_spent', 'tweet_like', 'profile_view']

def make_action(user_id, action_type, timestamp, target_id, ip="127.0.0.1", context_data=None, device_info=None):
    return {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "action_type": action_type,
        "timestamp": timestamp.isoformat(),
        "target_id": target_id,
        "ip_address": ip,
        "context_data": context_data or {},
        "device_info": device_info or {"os": "android", "model": "Pixel 7"}
    }

# ─── PROFILS HUMAINS ────────────────────────────────────────────────────────────

def generate_real_human():
    """Un vrai humain : il VIEW toujours un tweet avant de le LIKE.
    Delais tres variables (1.5s - 15s). Pas de longues series de likes."""
    user_id = f"human_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    num_actions = random.randint(40, 120)
    
    # Pool de tweets que l'humain a VU (il ne peut liker que ceux-la)
    viewed_targets = []
    ip = f"192.168.1.{random.randint(2, 254)}"
    battery = 100.0
    
    for _ in range(num_actions):
        delay = random.randint(1500, 15000)
        now -= timedelta(milliseconds=delay)
        battery -= random.uniform(0.01, 0.1) # Decharge naturelle
        
        # Decision naturelle sur quoi faire
        roll = random.random()
        
        # Contexte V5/V6
        ctx = {"battery_level": max(battery, 0)}
        
        if roll < 0.35:
            # Voir un nouveau tweet (scroll du feed)
            target = str(uuid.uuid4())
            viewed_targets.append(target)
            actions.append(make_action(user_id, 'tweet_view', now, target, ip, ctx))
        elif roll < 0.55:
            # Passer du temps sur un contenu vu
            target = random.choice(viewed_targets) if viewed_targets else str(uuid.uuid4())
            actions.append(make_action(user_id, 'time_spent', now, target, ip, ctx))
        elif roll < 0.70:
            # Scroll avec jitter humain
            target = random.choice(viewed_targets) if viewed_targets else str(uuid.uuid4())
            actions.append(make_action(user_id, 'scroll_jitter', now, target, ip, {"jitter": random.uniform(0.1, 0.8), **ctx}))
        elif roll < 0.85 and viewed_targets:
            # LIKE un tweet qu'on a VU (jamais un tweet random)
            target = random.choice(viewed_targets)
            actions.append(make_action(user_id, 'tweet_like', now, target, ip))
            
            # Action de Tap physique associee au like
            tap_time = now + timedelta(milliseconds=random.randint(5, 50))
            actions.append(make_action(user_id, 'tap_gesture', tap_time, target, ip, {"duration_ms": random.randint(30, 180)}))
        else:
            # Voir un profil
            actions.append(make_action(user_id, 'profile_view', now, str(uuid.uuid4()), ip))
            
        # Signal de mouvement humain periodique
        if random.random() < 0.1:
            actions.append(make_action(user_id, 'device_motion_noise', now, None, ip, {"variance": random.uniform(0.01, 0.4)}))
    
    return actions

def generate_casual_human():
    """Humain casual : peu d'actions, beaucoup de scroll, rare likes."""
    user_id = f"human_cas_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    
    viewed = []
    for _ in range(random.randint(20, 50)):
        delay = random.randint(3000, 20000)
        now -= timedelta(milliseconds=delay)
        
        roll = random.random()
        if roll < 0.45:
            t = str(uuid.uuid4())
            viewed.append(t)
            actions.append(make_action(user_id, 'tweet_view', now, t))
        elif roll < 0.75:
            actions.append(make_action(user_id, 'scroll_50', now, str(uuid.uuid4())))
        elif roll < 0.90:
            t = random.choice(viewed) if viewed else str(uuid.uuid4())
            actions.append(make_action(user_id, 'time_spent', now, t))
        else:
            if viewed:
                actions.append(make_action(user_id, 'tweet_like', now, random.choice(viewed)))
    
    return actions

def generate_power_user():
    """Power user : beaucoup d'actions, like souvent, mais VIEW avant."""
    user_id = f"human_pwr_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    
    viewed = []
    for _ in range(random.randint(80, 150)):
        delay = random.randint(800, 8000)
        now -= timedelta(milliseconds=delay)
        
        roll = random.random()
        if roll < 0.30:
            t = str(uuid.uuid4())
            viewed.append(t)
            actions.append(make_action(user_id, 'tweet_view', now, t))
        elif roll < 0.45:
            actions.append(make_action(user_id, 'scroll_50', now, str(uuid.uuid4())))
        elif roll < 0.55:
            t = random.choice(viewed) if viewed else str(uuid.uuid4())
            actions.append(make_action(user_id, 'time_spent', now, t))
        elif roll < 0.75 and viewed:
            actions.append(make_action(user_id, 'tweet_like', now, random.choice(viewed)))
        else:
            actions.append(make_action(user_id, 'profile_view', now, str(uuid.uuid4())))
    
    return actions

# ─── PROFILS BOTS ───────────────────────────────────────────────────────────────

def generate_like_only_bot():
    """Bot stupide : que des likes, JAMAIS de view. Delais humains."""
    bot_id = f"bot_like_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    for _ in range(random.randint(30, 80)):
        delay = random.randint(800, 6000)
        now -= timedelta(milliseconds=delay)
        # CHAQUE like est sur un target DIFFERENT et JAMAIS vu
        # Un bot a souvent une IP stable (ferme) ou change trop (proxy)
        actions.append(make_action(bot_id, 'tweet_like', now, str(uuid.uuid4()), "192.168.1.10", device_info={"os": "android", "model": "BotEMU-1"}))
        # PAS de tap duration pour un bot basique
    return actions

def generate_ghost_viewer():
    """Bot fantome : que des views et scrolls, zero interaction."""
    bot_id = f"bot_ghost_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    for _ in range(random.randint(50, 120)):
        delay = random.randint(1000, 5000)
        now -= timedelta(milliseconds=delay)
        t = random.choice(['tweet_view', 'scroll_50'])
        # Bot fantome : IP fixe, pas de tap, pas de motion
        actions.append(make_action(bot_id, t, now, str(uuid.uuid4()), ip="1.1.1.1", context_data={"battery_level": 100.0}))
    return actions

def generate_metronome_bot():
    """Bot metronome : delais parfaitement constants (script timer)."""
    bot_id = f"bot_metro_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    fixed_delay = random.choice([2000, 3000, 5000])
    for _ in range(random.randint(40, 100)):
        now -= timedelta(milliseconds=fixed_delay)
        actions.append(make_action(bot_id, random.choice(['tweet_view', 'tweet_like']), now, str(uuid.uuid4())))
    return actions

def generate_burst_bot():
    """Bot rafale : 5-10 actions en <1s, puis 30s de rien (click farm)."""
    bot_id = f"bot_burst_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    for _ in range(random.randint(4, 8)):
        for _ in range(random.randint(5, 10)):
            now -= timedelta(milliseconds=random.randint(50, 300))
            actions.append(make_action(bot_id, random.choice(['tweet_like', 'tweet_view']), now, str(uuid.uuid4())))
        now -= timedelta(seconds=random.randint(15, 60))
    return actions

def generate_spray_liker_bot():
    """Bot spray : like en masse des tweets differents tres vite. Delais courts."""
    bot_id = f"bot_spray_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    for _ in range(random.randint(50, 150)):
        delay = random.randint(100, 800)
        now -= timedelta(milliseconds=delay)
        actions.append(make_action(bot_id, 'tweet_like', now, str(uuid.uuid4())))
    return actions

def generate_slow_stealth_bot():
    """Bot furtif lent : comme un humain mais ne like JAMAIS un tweet vu.
    C'est LE cas test du user (5s entre chaque, que des likes sans view)."""
    bot_id = f"bot_stealth_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    for _ in range(random.randint(20, 60)):
        delay = random.randint(3000, 8000)
        now -= timedelta(milliseconds=delay)
        # Parfois il view, parfois il like, mais JAMAIS le meme target
        if random.random() < 0.3:
            actions.append(make_action(bot_id, 'tweet_view', now, str(uuid.uuid4())))
        else:
            actions.append(make_action(bot_id, 'tweet_like', now, str(uuid.uuid4())))
    return actions

def generate_sequential_bot():
    """Bot sequentiel : like une liste de tweets fixes dans l'ordre exact.
    Faible diversite de cibles, pattern lineaire."""
    bot_id = f"bot_seq_{uuid.uuid4().hex[:8]}"
    actions = []
    now = datetime.now()
    # Genere une liste fixe de cibles
    fixed_targets = [str(uuid.uuid4()) for _ in range(10)]
    for cycle in range(random.randint(2, 5)):
        for target in fixed_targets:
            delay = random.randint(1000, 4000)
            now -= timedelta(milliseconds=delay)
            actions.append(make_action(bot_id, 'tweet_like', now, target))
    return actions

# ─── MAIN ───────────────────────────────────────────────────────────────────────

def main():
    print(f"[GEN v{VERSION}] Generation de {NUM_SESSIONS_PER_SIDE * 2} sessions...")
    
    # HUMAINS (3 profils differents)
    human_data = []
    human_generators = [generate_real_human, generate_casual_human, generate_power_user]
    for _ in range(NUM_SESSIONS_PER_SIDE):
        gen = random.choice(human_generators)
        human_data.extend(gen())
    
    with open(HUMAN_FILE, 'w') as f:
        json.dump(human_data, f, indent=2)
    print(f"[OK] {NUM_SESSIONS_PER_SIDE} Humains generes ({len(human_data)} actions)")

    # BOTS (7 profils differents)
    bot_data = []
    bot_generators = [
        generate_like_only_bot,
        generate_ghost_viewer,
        generate_metronome_bot,
        generate_burst_bot,
        generate_spray_liker_bot,
        generate_slow_stealth_bot,
        generate_sequential_bot,
    ]
    for _ in range(NUM_SESSIONS_PER_SIDE):
        gen = random.choice(bot_generators)
        bot_data.extend(gen())
    
    with open(BOT_FILE, 'w') as f:
        json.dump(bot_data, f, indent=2)
    print(f"[OK] {NUM_SESSIONS_PER_SIDE} Bots generes ({len(bot_data)} actions, 7 profils)")

if __name__ == "__main__":
    main()
