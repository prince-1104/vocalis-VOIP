import { useEffect } from "react";

export default function WidgetDemo() {
  useEffect(() => {
    // Inject widget script
    const existing = document.getElementById("demo-widget-script");
    if (existing) existing.remove();

    const s = document.createElement("script");
    s.src = window.location.origin + "/api/widget/loader.js?key=fc54b771-c5b8-4e64-878B-43590b04da08";
    s.id = "demo-widget-script";
    s.defer = true;
    document.body.appendChild(s);

    return () => {
      const script = document.getElementById("demo-widget-script");
      if (script) script.remove();
      const fab = document.getElementById("_dw-fab");
      if (fab) fab.remove();
      const box = document.getElementById("_dw-box");
      if (box) box.remove();
    };
  }, []);

  return (
    <>
      <style>{`
        .wd-page { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: #0a0a0f; color: #f1f5f9; line-height: 1.6; overflow-x: hidden; min-height: 100vh; }
        .wd-bg { position: fixed; inset: 0; background: radial-gradient(ellipse 80% 60% at 20% 10%, rgba(124,58,237,0.15), transparent 60%), radial-gradient(ellipse 60% 50% at 80% 80%, rgba(6,182,212,0.1), transparent 50%); z-index: 0; animation: wdBgShift 12s ease-in-out infinite alternate; }
        @keyframes wdBgShift { 0% { opacity: 0.8; } 100% { opacity: 1; } }
        .wd-grid { position: fixed; inset: 0; background-image: linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px); background-size: 60px 60px; z-index: 0; }

        .wd-nav { position: fixed; top: 0; left: 0; right: 0; padding: 16px 40px; display: flex; align-items: center; justify-content: space-between; backdrop-filter: blur(20px); background: rgba(10,10,15,0.7); border-bottom: 1px solid rgba(255,255,255,0.08); z-index: 1000; }
        .wd-logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 20px; }
        .wd-logo-icon { width: 36px; height: 36px; background: linear-gradient(135deg, #7c3aed, #06b6d4); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
        .wd-nav-links { display: flex; gap: 32px; list-style: none; margin: 0; padding: 0; }
        .wd-nav-links a { color: #94a3b8; text-decoration: none; font-size: 14px; font-weight: 500; transition: color 0.2s; }
        .wd-nav-links a:hover { color: #f1f5f9; }
        .wd-nav-cta { background: linear-gradient(135deg, #7c3aed, #5b21b6); color: white; border: none; padding: 10px 24px; border-radius: 10px; font-weight: 600; font-size: 14px; cursor: pointer; box-shadow: 0 4px 15px rgba(124,58,237,0.3); transition: all 0.3s; }
        .wd-nav-cta:hover { transform: translateY(-1px); box-shadow: 0 6px 25px rgba(124,58,237,0.45); }

        .wd-hero { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 120px 20px 80px; position: relative; z-index: 1; }
        .wd-badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 16px; border-radius: 100px; background: rgba(124,58,237,0.12); border: 1px solid rgba(124,58,237,0.2); font-size: 13px; color: #a78bfa; font-weight: 500; margin-bottom: 28px; animation: wdFadeUp 0.8s ease; }
        .wd-hero h1 { font-size: clamp(40px, 6vw, 72px); font-weight: 800; line-height: 1.1; letter-spacing: -2px; max-width: 800px; animation: wdFadeUp 0.8s ease 0.1s both; }
        .wd-gradient-text { background: linear-gradient(135deg, #a78bfa, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
        .wd-hero p { font-size: 18px; color: #94a3b8; max-width: 560px; margin: 24px auto 0; line-height: 1.7; animation: wdFadeUp 0.8s ease 0.2s both; }
        .wd-hero-buttons { display: flex; gap: 16px; margin-top: 40px; animation: wdFadeUp 0.8s ease 0.3s both; }
        .wd-btn-primary { background: linear-gradient(135deg, #7c3aed, #5b21b6); color: white; border: none; padding: 14px 32px; border-radius: 12px; font-weight: 600; font-size: 16px; cursor: pointer; box-shadow: 0 4px 20px rgba(124,58,237,0.35); transition: all 0.3s; }
        .wd-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(124,58,237,0.5); }
        .wd-btn-secondary { background: rgba(255,255,255,0.04); color: #f1f5f9; border: 1px solid rgba(255,255,255,0.08); padding: 14px 32px; border-radius: 12px; font-weight: 600; font-size: 16px; cursor: pointer; backdrop-filter: blur(10px); transition: all 0.3s; }
        .wd-btn-secondary:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }

        .wd-stats { display: flex; gap: 48px; margin-top: 60px; animation: wdFadeUp 0.8s ease 0.4s both; }
        .wd-stat-value { font-size: 32px; font-weight: 800; background: linear-gradient(135deg, #a78bfa, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .wd-stat-label { font-size: 13px; color: #94a3b8; margin-top: 4px; font-weight: 500; }

        .wd-section { padding: 100px 40px; max-width: 1200px; margin: 0 auto; position: relative; z-index: 1; }
        .wd-section h2 { text-align: center; font-size: 36px; font-weight: 700; letter-spacing: -1px; margin-bottom: 16px; }
        .wd-section > p { text-align: center; color: #94a3b8; font-size: 16px; max-width: 500px; margin: 0 auto 60px; }

        .wd-features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }
        .wd-feature-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 32px; transition: all 0.3s; position: relative; overflow: hidden; }
        .wd-feature-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, #7c3aed, #06b6d4); opacity: 0; transition: opacity 0.3s; }
        .wd-feature-card:hover { border-color: rgba(124,58,237,0.3); transform: translateY(-4px); box-shadow: 0 12px 40px rgba(124,58,237,0.1); }
        .wd-feature-card:hover::before { opacity: 1; }
        .wd-feature-icon { width: 48px; height: 48px; border-radius: 12px; background: rgba(124,58,237,0.12); display: flex; align-items: center; justify-content: center; font-size: 24px; margin-bottom: 20px; }
        .wd-feature-card h3 { font-size: 18px; font-weight: 600; margin-bottom: 10px; }
        .wd-feature-card p { color: #94a3b8; font-size: 14px; line-height: 1.6; }

        .wd-pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; max-width: 1000px; margin: 0 auto; }
        .wd-pricing-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 32px; text-align: center; transition: all 0.3s; }
        .wd-pricing-card.featured { border-color: rgba(124,58,237,0.4); background: rgba(124,58,237,0.06); position: relative; }
        .wd-pricing-card.featured::after { content: 'Most Popular'; position: absolute; top: -12px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg, #7c3aed, #06b6d4); color: white; padding: 4px 16px; border-radius: 100px; font-size: 12px; font-weight: 600; }
        .wd-pricing-card:hover { transform: translateY(-4px); box-shadow: 0 12px 40px rgba(0,0,0,0.3); }
        .wd-pricing-card h3 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
        .wd-price { font-size: 48px; font-weight: 800; margin: 16px 0; letter-spacing: -2px; }
        .wd-price span { font-size: 16px; font-weight: 400; color: #94a3b8; }
        .wd-pricing-card ul { list-style: none; text-align: left; margin: 24px 0; padding: 0; }
        .wd-pricing-card ul li { padding: 8px 0; font-size: 14px; color: #94a3b8; display: flex; align-items: center; gap: 10px; }
        .wd-pricing-card ul li::before { content: '✓'; color: #4ade80; font-weight: 700; }

        .wd-cta-inner { max-width: 700px; margin: 0 auto; padding: 60px 40px; background: linear-gradient(135deg, rgba(124,58,237,0.15), rgba(6,182,212,0.08)); border: 1px solid rgba(124,58,237,0.2); border-radius: 24px; text-align: center; position: relative; overflow: hidden; }
        .wd-cta-inner h2 { font-size: 32px; font-weight: 700; margin-bottom: 16px; position: relative; }
        .wd-cta-inner p { color: #94a3b8; font-size: 16px; margin-bottom: 32px; position: relative; }
        .wd-cta-inner button { position: relative; }

        .wd-footer { padding: 40px; text-align: center; color: #94a3b8; font-size: 13px; border-top: 1px solid rgba(255,255,255,0.08); position: relative; z-index: 1; }

        .wd-widget-info { position: fixed; bottom: 90px; right: 90px; background: rgba(124,58,237,0.15); backdrop-filter: blur(12px); border: 1px solid rgba(124,58,237,0.3); padding: 12px 20px; border-radius: 12px; font-size: 13px; color: #a78bfa; z-index: 99997; animation: wdBounce 2s ease-in-out infinite, wdFadeUp 0.5s ease; pointer-events: none; }
        @keyframes wdBounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes wdFadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

        @media (max-width: 768px) {
          .wd-nav { padding: 12px 20px; }
          .wd-nav-links { display: none; }
          .wd-hero { padding: 100px 20px 60px; }
          .wd-stats { gap: 24px; flex-wrap: wrap; }
          .wd-section { padding: 60px 20px; }
          .wd-widget-info { display: none; }
        }
      `}</style>

      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />

      <div className="wd-page">
        <div className="wd-bg" />
        <div className="wd-grid" />

        {/* Navigation */}
        <nav className="wd-nav">
          <div className="wd-logo">
            <div className="wd-logo-icon">🧠</div>
            NoeticMinds
          </div>
          <ul className="wd-nav-links">
            <li><a href="#features">Features</a></li>
            <li><a href="#pricing">Pricing</a></li>
            <li><a href="#contact">Contact</a></li>
          </ul>
          <button className="wd-nav-cta">Start Free Trial</button>
        </nav>

        {/* Hero */}
        <section className="wd-hero">
          <div className="wd-badge">✨ Now with AI Voice Calling</div>
          <h1>
            Close More Deals with<br />
            <span className="wd-gradient-text">AI-Powered CRM</span>
          </h1>
          <p>
            Automate lead scoring, follow-ups, and outbound calls with intelligent AI.
            Your sales team focuses on closing — our AI handles the rest.
          </p>
          <div className="wd-hero-buttons">
            <button className="wd-btn-primary">Get Started Free →</button>
            <button className="wd-btn-secondary">Watch Demo</button>
          </div>
          <div className="wd-stats">
            <div style={{ textAlign: "center" }}>
              <div className="wd-stat-value">40%</div>
              <div className="wd-stat-label">More Conversions</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div className="wd-stat-value">10hrs</div>
              <div className="wd-stat-label">Saved Per Week</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div className="wd-stat-value">500+</div>
              <div className="wd-stat-label">Happy Customers</div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="wd-section" id="features">
          <h2>Everything You Need to Sell Smarter</h2>
          <p>AI-powered tools that transform your entire sales pipeline from lead to close.</p>
          <div className="wd-features-grid">
            {[
              { icon: "🎯", title: "AI Lead Scoring", desc: "Automatically ranks leads by likelihood to convert. Focus your energy on deals that matter most." },
              { icon: "🤖", title: "Smart Follow-ups", desc: "Personalized emails and SMS sent at the perfect time. Never let a warm lead go cold again." },
              { icon: "📞", title: "AI Voice Calling", desc: "Our AI agent makes outbound calls following your scripts. Handles objections naturally and books meetings." },
              { icon: "📊", title: "Real-time Analytics", desc: "Live dashboards showing pipeline health, team performance, and revenue forecasts at a glance." },
              { icon: "🔗", title: "Seamless Integrations", desc: "Works with Gmail, Slack, HubSpot, Salesforce, and 50+ other tools your team already uses." },
              { icon: "🌐", title: "Multilingual Support", desc: "AI conversations in English, Hindi, Kannada, Tamil, Telugu, and Marathi. Sell across India." },
            ].map((f, i) => (
              <div className="wd-feature-card" key={i}>
                <div className="wd-feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing */}
        <section className="wd-section" id="pricing">
          <h2>Simple, Transparent Pricing</h2>
          <p>Start free, scale as you grow. No hidden fees, no long-term contracts.</p>
          <div className="wd-pricing-grid">
            <div className="wd-pricing-card">
              <h3>Starter</h3>
              <div className="wd-price">$49<span>/mo</span></div>
              <ul>
                <li>Up to 500 contacts</li>
                <li>AI lead scoring</li>
                <li>Email follow-ups</li>
                <li>Basic analytics</li>
                <li>1 user seat</li>
              </ul>
              <button className="wd-btn-secondary" style={{ width: "100%" }}>Get Started</button>
            </div>
            <div className="wd-pricing-card featured">
              <h3>Professional</h3>
              <div className="wd-price">$99<span>/mo</span></div>
              <ul>
                <li>Unlimited contacts</li>
                <li>AI voice calling</li>
                <li>Smart follow-ups</li>
                <li>Advanced analytics</li>
                <li>5 user seats</li>
              </ul>
              <button className="wd-btn-primary" style={{ width: "100%" }}>Start Free Trial</button>
            </div>
            <div className="wd-pricing-card">
              <h3>Enterprise</h3>
              <div className="wd-price">Custom</div>
              <ul>
                <li>Everything in Pro</li>
                <li>Dedicated support</li>
                <li>Custom integrations</li>
                <li>SLA guarantee</li>
                <li>Unlimited seats</li>
              </ul>
              <button className="wd-btn-secondary" style={{ width: "100%" }}>Contact Sales</button>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="wd-section" id="contact">
          <div className="wd-cta-inner">
            <h2>Ready to Transform Your Sales?</h2>
            <p>Join 500+ companies already using NoeticMinds AI CRM to close more deals.</p>
            <button className="wd-btn-primary">Start Your Free 14-Day Trial →</button>
          </div>
        </section>

        {/* Footer */}
        <footer className="wd-footer">
          <p>© 2026 NoeticMinds Inc. All rights reserved. | Built with ❤️ in Bangalore</p>
        </footer>

        {/* Widget pointer */}
        <div className="wd-widget-info">
          👋 Chat with our AI — try the widget! →
        </div>
      </div>
    </>
  );
}
