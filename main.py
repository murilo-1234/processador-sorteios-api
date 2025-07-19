from flask import Flask
from flask_cors import CORS
import os

app = Flask(__name__)
CORS(app)

@app.route('/')
def home():
    return '''
    <h1>🎉 Sistema Processador de Sorteios</h1>
    <p>✅ Sistema funcionando!</p>
    <p>🔗 <a href="/api/sorteios/health">Health Check</a></p>
    '''

@app.route('/api/sorteios/health')
def health():
    return {"status": "ok", "message": "Sistema funcionando"}

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
