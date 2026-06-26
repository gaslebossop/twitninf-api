import json
import joblib
import pandas as pd
import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# Configuration
MODEL_FILE = os.path.join(os.path.dirname(__file__), 'bot_brain.joblib')
PORT = 6789

class UserFeatures(BaseModel):
    # Features de Base (11)
    avg_delay: float
    regularity: float
    engagement_ratio: float
    human_signal_ratio: float
    entropy: float
    unique_actions_ratio: float
    intensity: float
    orphan_like_ratio: float
    max_like_streak: float
    target_diversity: float
    burst_score: float

    # V5: Human Precision (Nouveautés)
    avg_tap_duration: float = 0.3
    motion_variance: float = 0.05
    typing_speed_entropy: float = 0.5
    scroll_jitter_score: float = 0.1
    
    # V6: Environment (Nouveautés)
    unique_ip_ratio: float = 0.1
    fingerprint_stability: float = 1.0
    battery_chaos: float = 0.5

app = FastAPI(title="BotBrain Engine v22.0 (Contextual Beast)")

print(f"[BRAIN] Chargement du modele depuis {MODEL_FILE}...")
try:
    model = joblib.load(MODEL_FILE)
    print("[OK] Modele pret (11 features).")
except Exception as e:
    print(f"[ERREUR] {e}")
    model = None

@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": model is not None, "version": "22.0"}

@app.post("/predict")
def predict(features: UserFeatures):
    if model is None: raise HTTPException(status_code=500)
    try:
        data = features.model_dump()
        df = pd.DataFrame([data])
        probs = model.predict_proba(df)[0]
        bot_prob = float(probs[1])
        score = int(bot_prob * 100)
        
        # --- EXPLAINABILITY AVANCEE ---
        reasons = []
        if bot_prob > 0.5:
            if data['orphan_like_ratio'] > 0.5:
                reasons.append(f"Likes sans lecture prealable ({int(data['orphan_like_ratio']*100)}% orphelins)")
            if data['entropy'] < 0.3:
                reasons.append("Sequence trop mecanique (Entropie faible)")
            if data['max_like_streak'] > 0.3:
                reasons.append(f"Serie de likes consecutifs ({int(data['max_like_streak']*100)}% du total)")
            if data['unique_actions_ratio'] < 0.4:
                reasons.append("Mono-tache (peu de types d'actions)")
            if data['regularity'] < 0.15:
                reasons.append("Rythme trop constant (Machine)")
            if data['avg_delay'] < 0.05:
                reasons.append("Vitesse inhumaine")
            if data['burst_score'] > 0.3:
                reasons.append(f"Rafales detectees ({int(data['burst_score']*100)}% d'actions rapides)")
            if data['intensity'] > 0.8:
                reasons.append("Intensite excessive")
            if data['human_signal_ratio'] < 0.05:
                reasons.append("Aucun signal humain (scroll/lecture)")
        
        # --- MONITORING LIVE ---
        status = "BOT" if bot_prob > 0.70 else "HUMAIN"
        icon = "\U0001f916" if bot_prob > 0.70 else "\U0001f464"
        color = "\033[91m" if bot_prob > 0.70 else "\033[92m"
        reset = "\033[0m"
        
        print(f"\n{'-'*50}")
        print(f"ANALYSE | Verdict : {color}{icon} {status}{reset}")
        print(f"Score : {score}% (Prob: {bot_prob:.4f})")
        print(f"Stats : V={data['avg_delay']:.3f} | R={data['regularity']:.3f} | E={data['entropy']:.3f} | I={data['intensity']:.3f}")
        print(f"Context: Orphan={data['orphan_like_ratio']:.2f} | Streak={data['max_like_streak']:.2f} | Div={data['target_diversity']:.2f} | Burst={data['burst_score']:.2f}")
        if reasons: print(f"MOTIFS : {', '.join(reasons)}")
        print(f"{'-'*50}")
        
        return {
            "botProbability": bot_prob,
            "isBot": bot_prob > 0.70,
            "score": score,
            "reasons": reasons
        }
    except Exception as e:
        print(f"[ERREUR] Predict : {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT)