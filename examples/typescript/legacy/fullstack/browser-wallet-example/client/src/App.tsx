import React, { useState, useEffect } from 'react';
import { WalletConnect } from './components/WalletConnect';
import { useWallet } from './contexts/WalletContext';
import { api, updateApiClient, type PaymentOption, type Session } from './services/api';
import './App.css';

function App() {
  const { walletClient } = useWallet();
  const [serverStatus, setServerStatus] = useState<string>('checking...');
  const [paymentOptions, setPaymentOptions] = useState<PaymentOption[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [sessionInput, setSessionInput] = useState<string>('');
  const [validationResult, setValidationResult] = useState<any>(null);

  // Update API client when wallet changes
  useEffect(() => {
    updateApiClient(walletClient);
  }, [walletClient]);

  // Check server health on mount
  useEffect(() => {
    checkServerHealth();
    loadPaymentOptions();
    loadActiveSessions();
  }, []);

  const checkServerHealth = async () => {
    try {
      const health = await api.getHealth();
      setServerStatus(`✅ Connected to ${health.config.network}`);
    } catch (error) {
      setServerStatus('❌ Server offline');
    }
  };

  const loadPaymentOptions = async () => {
    try {
      const data = await api.getPaymentOptions();
      setPaymentOptions(data.options);
    } catch (error) {
      console.error('Failed to load payment options:', error);
    }
  };

  const loadActiveSessions = async () => {
    try {
      const data = await api.getActiveSessions();
      setSessions(data.sessions);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const handle24HourSession = async () => {
    setLoading('session');
    try {
      const result = await api.purchase24HourSession();
      await loadActiveSessions();
      setValidationResult({
        type: 'success',
        message: result.message,
        session: result.session,
      });
    } catch (error: any) {
      setValidationResult({
        type: 'error',
        message: error.message || 'Failed to purchase session',
      });
    } finally {
      setLoading(null);
    }
  };

  const handleOneTimeAccess = async () => {
    setLoading('onetime');
    try {
      const result = await api.purchaseOneTimeAccess();
      await loadActiveSessions();
      setValidationResult({
        type: 'success',
        message: result.message,
        access: result.access,
      });
    } catch (error: any) {
      setValidationResult({
        type: 'error',
        message: error.message || 'Failed to purchase access',
      });
    } finally {
      setLoading(null);
    }
  };

  const validateSession = async () => {
    if (!sessionInput.trim()) {
      setValidationResult({
        type: 'error',
        message: 'Please enter a session ID',
      });
      return;
    }

    try {
      const result = await api.validateSession(sessionInput);
      setValidationResult(result);
      if (result.valid && result.session?.type === 'onetime') {
        // Refresh sessions since one-time was just used
        await loadActiveSessions();
      }
    } catch (error: any) {
      setValidationResult({
        type: 'error',
        message: error.message || 'Failed to validate session',
      });
    }
  };

  return (
    <div className="app">
      <header>
        <h1>x402 Payment Template</h1>
        <p>Build your own payment-enabled app with this starter template</p>
        <div className="server-status">{serverStatus}</div>
      </header>

      <main>
        <section className="wallet-section">
          <h2>1. Connect Your Wallet</h2>
          <WalletConnect />
        </section>

        <section className="payment-section">
          <h2>2. Payment Options</h2>
          <div className="payment-grid">
            {paymentOptions.map((option) => (
              <div key={option.endpoint} className="payment-card">
                <h3>{option.name}</h3>
                <p className="price">{option.price}</p>
                <p className="description">{option.description}</p>

                {option.endpoint === '/api/pay/session' && (
                  <button
                    onClick={handle24HourSession}
                    disabled={loading === 'session'}
                    className="action-btn"
                  >
                    {loading === 'session' ? 'Processing...' : 'Purchase 24-Hour Session'}
                  </button>
                )}

                {option.endpoint === '/api/pay/onetime' && (
                  <button
                    onClick={handleOneTimeAccess}
                    disabled={loading === 'onetime'}
                    className="action-btn"
                  >
                    {loading === 'onetime' ? 'Processing...' : 'Purchase One-Time Access'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="validation-section">
          <h2>3. Validate Session</h2>
          <div className="session-validator">
            <input
              type="text"
              placeholder="Enter session ID"
              value={sessionInput}
              onChange={(e) => setSessionInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && validateSession()}
              className="session-input"
            />
            <button onClick={validateSession} className="validate-btn">
              Check Session
            </button>
          </div>

          {validationResult && (
            <div className={`validation-result ${validationResult.type || (validationResult.valid ? 'success' : 'error')}`}>
              {validationResult.message && <p>{validationResult.message}</p>}
              {validationResult.error && <p>❌ {validationResult.error}</p>}
              {validationResult.valid && (
                <div>
                  <p>✅ Session is valid!</p>
                  {validationResult.session && (
                    <div className="session-details">
                      <p><strong>Type:</strong> {validationResult.session.type}</p>
                      <p><strong>Created:</strong> {new Date(validationResult.session.createdAt).toLocaleString()}</p>
                      <p><strong>Expires:</strong> {new Date(validationResult.session.expiresAt).toLocaleString()}</p>
                      {validationResult.session.remainingTime && (
                        <p><strong>Remaining:</strong> {Math.floor(validationResult.session.remainingTime / 1000 / 60)} minutes</p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {validationResult.session && !validationResult.valid && (
                <div className="session-details">
                  <p><strong>Session ID:</strong> {validationResult.session.id}</p>
                  <p><strong>Type:</strong> {validationResult.session.type}</p>
                  <p><strong>Status:</strong> {validationResult.error}</p>
                </div>
              )}
              {validationResult.access && (
                <div className="access-details">
                  <p><strong>Access ID:</strong> {validationResult.access.id}</p>
                  <p><strong>Valid for:</strong> {validationResult.access.validFor}</p>
                </div>
              )}
            </div>
          )}
        </section>

        {sessions.length > 0 && (
          <section className="sessions-section">
            <h2>Active Sessions</h2>
            <div className="sessions-list">
              {sessions.map((session) => (
                <div key={session.id} className="session-item">
                  <code>{session.id}</code>
                  <span className={`session-type ${session.type}`}>{session.type}</span>
                  <span className="session-expires">
                    Expires: {new Date(session.expiresAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer>
        <p>
          This simplified example demonstrates two payment models: 24-hour session access and one-time payments.
          Each purchase requires approval in wallet.
        </p>
        <div className="builder-resources">
          <h3>🛠️ Build with x402</h3>
          <p>This is a template to help you build your own payment-enabled applications!</p>
          <div className="resource-links">
            <a href="https://x402.org" target="_blank" rel="noopener noreferrer">
              📚 x402 Documentation
            </a>
            <a href="https://github.com/x402-foundation/x402" target="_blank" rel="noopener noreferrer">
              💻 GitHub Repository
            </a>
            <a href="https://discord.gg/invite/cdp" target="_blank" rel="noopener noreferrer">
              💬 Discord Community
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App; 