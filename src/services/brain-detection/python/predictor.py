import sys
import json
import joblib
import pandas as pd
import os

# Chargement silencieux du modèle
MODEL_FILE = os.path.join(os.path.dirname(__file__), 'bot_brain.joblib')

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No features provided"}))
        return

    try:
        # Récupération des features depuis l'argument (JSON string)
        features_dict = json.loads(sys.argv[1])
        df = pd.DataFrame([features_dict])
        
        # Chargement du modèle
        model = joblib.load(MODEL_FILE)
        
        # Prédiction des probabilités
        # [0, 1] -> [Humain, Bot]
        probs = model.predict_proba(df)[0]
        bot_prob = float(probs[1])
        
        result = {
            "botProbability": bot_prob,
            "isBot": bot_prob > 0.85, # Seuil de ban plus sévère pour XGBoost
            "score": int(bot_prob * 100)
        }
        
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
