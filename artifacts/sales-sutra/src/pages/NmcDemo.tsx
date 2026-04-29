import { useEffect } from "react";
import { ArrowRight, Bot, Cpu, Globe, MessageSquare, Zap } from "lucide-react";

export default function NmcDemo() {
  useEffect(() => {
    // Inject the widget script
    const s = document.createElement("script");
    // Uses window.location.origin so it automatically works in production (dialog.noeticminds.com)
    // Note: You may need to change this key to your production tenant key if the local key doesn't exist on production DB
    s.src = window.location.origin + "/api/widget/loader.js?key=fc64b771-c5b8-4e64-8768-43590504da08";
    s.id = "nmc-demo-widget-script";
    s.defer = true;
    document.body.appendChild(s);

    return () => {
      // Cleanup script and widget container when navigating away
      const existingScript = document.getElementById("nmc-demo-widget-script");
      if (existingScript) existingScript.remove();
      const existingContainer = document.getElementById("_dw-container");
      if (existingContainer) existingContainer.remove();
      const existingFab = document.getElementById("_dw-fab");
      if (existingFab) existingFab.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 overflow-x-hidden">
      {/* Navigation */}
      <nav className="bg-white border-b border-slate-200 sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-indigo-600 text-white rounded-lg flex items-center justify-center font-bold text-xl shadow-md">
              NMC
            </div>
            <span className="text-xl font-bold tracking-tight text-slate-800">NoeticMinds Consulting</span>
          </div>
          <div className="hidden md:flex gap-8 font-medium text-slate-600">
            <a href="#" className="hover:text-indigo-600 transition-colors">Services</a>
            <a href="#" className="hover:text-indigo-600 transition-colors">Solutions</a>
            <a href="#" className="hover:text-indigo-600 transition-colors">About Us</a>
            <a href="#" className="hover:text-indigo-600 transition-colors">Contact</a>
          </div>
          <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2.5 rounded-full font-medium transition-all shadow-sm">
            Get Started
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <div className="relative overflow-hidden bg-slate-900 text-white">
        {/* Background gradient/pattern */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f46e5,#0f172a)] opacity-90"></div>
        <div className="absolute top-0 right-0 -mr-48 -mt-48 w-96 h-96 rounded-full bg-indigo-500 blur-3xl opacity-20"></div>
        <div className="absolute bottom-0 left-0 -ml-48 -mb-48 w-96 h-96 rounded-full bg-blue-500 blur-3xl opacity-20"></div>
        
        <div className="relative max-w-7xl mx-auto px-6 py-24 md:py-32 flex flex-col items-center text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/20 border border-indigo-400/30 text-indigo-200 mb-8 text-sm font-medium">
            <Zap className="w-4 h-4 text-yellow-400" />
            <span>Next-Generation AI Solutions</span>
          </div>
          
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-6 leading-tight max-w-4xl">
            Empower Your Business with <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">Intelligent Automation</span>
          </h1>
          
          <p className="text-lg md:text-xl text-slate-300 mb-10 max-w-2xl leading-relaxed">
            NMC helps enterprises scale faster by integrating cutting-edge conversational AI, predictive analytics, and workflow automation seamlessly into your operations.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4">
            <button className="px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold transition-all shadow-[0_0_20px_rgba(79,70,229,0.4)] flex items-center justify-center gap-2">
              Explore Services <ArrowRight className="w-5 h-5" />
            </button>
            <button className="px-8 py-4 bg-white/10 hover:bg-white/20 border border-white/20 text-white rounded-lg font-bold transition-all flex items-center justify-center gap-2">
              Schedule Demo
            </button>
          </div>
        </div>
      </div>

      {/* Features Section */}
      <div className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-slate-900 mb-4">Why Choose NoeticMinds?</h2>
            <p className="text-slate-500 max-w-2xl mx-auto">We bridge the gap between complex AI technology and practical business value.</p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-8">
            <div className="p-8 rounded-2xl bg-slate-50 border border-slate-100 hover:shadow-lg transition-all hover:-translate-y-1">
              <div className="w-14 h-14 bg-indigo-100 rounded-xl flex items-center justify-center mb-6 text-indigo-600">
                <Bot className="w-7 h-7" />
              </div>
              <h3 className="text-xl font-bold mb-3 text-slate-900">Conversational AI</h3>
              <p className="text-slate-600 leading-relaxed">Deploy smart agents that understand context, resolve issues instantly, and provide 24/7 support to your customers.</p>
            </div>
            
            <div className="p-8 rounded-2xl bg-slate-50 border border-slate-100 hover:shadow-lg transition-all hover:-translate-y-1">
              <div className="w-14 h-14 bg-cyan-100 rounded-xl flex items-center justify-center mb-6 text-cyan-600">
                <Cpu className="w-7 h-7" />
              </div>
              <h3 className="text-xl font-bold mb-3 text-slate-900">Machine Learning</h3>
              <p className="text-slate-600 leading-relaxed">Leverage your proprietary data to build predictive models that forecast trends and optimize your resources.</p>
            </div>
            
            <div className="p-8 rounded-2xl bg-slate-50 border border-slate-100 hover:shadow-lg transition-all hover:-translate-y-1">
              <div className="w-14 h-14 bg-blue-100 rounded-xl flex items-center justify-center mb-6 text-blue-600">
                <Globe className="w-7 h-7" />
              </div>
              <h3 className="text-xl font-bold mb-3 text-slate-900">Global Integration</h3>
              <p className="text-slate-600 leading-relaxed">Seamlessly connect our intelligent solutions with your existing CRM, ERP, and communication platforms worldwide.</p>
            </div>
          </div>
        </div>
      </div>
      
    </div>
  );
}
