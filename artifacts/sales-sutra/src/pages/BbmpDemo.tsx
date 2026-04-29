import { useEffect } from "react";
import { Search, Phone, User, LogIn, FileText, CheckCircle, XCircle, FilePlus, Globe, Building2 } from "lucide-react";

export default function BbmpDemo() {
  useEffect(() => {
    const s = document.createElement("script");
    s.src = window.location.origin + "/api/widget/loader.js?key=fc64b771-c5b8-4e64-8768-43590504da08";
    s.id = "bbmp-demo-widget-script";
    s.defer = true;
    document.body.appendChild(s);

    return () => {
      // Cleanup script and widget container when navigating away
      const existingScript = document.getElementById("bbmp-demo-widget-script");
      if (existingScript) existingScript.remove();
      const existingContainer = document.getElementById("_dw-container");
      if (existingContainer) existingContainer.remove();
      const existingFab = document.getElementById("_dw-fab");
      if (existingFab) existingFab.remove();
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800">
      {/* Blue Header Section */}
      <div className="bg-[#1e5eb8] text-white py-4 px-6 shadow-md relative overflow-hidden">
        {/* subtle background pattern could go here */}
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4 relative z-10">
          
          {/* Left - CM Profile */}
          <div className="flex flex-col items-center text-center max-w-[150px]">
            <div className="w-16 h-16 rounded-full bg-gray-300 border-2 border-white overflow-hidden mb-2 shadow-sm flex items-center justify-center">
              <User className="text-gray-500 w-8 h-8" />
            </div>
            <p className="font-bold text-sm leading-tight">Sri Siddaramaiah</p>
            <p className="text-[10px] text-gray-200 mt-1 leading-tight bg-black/20 p-1 rounded">Hon'ble Chief Minister<br/>Government of Karnataka</p>
          </div>

          {/* Center Content */}
          <div className="flex flex-col md:flex-row items-center gap-8 text-center flex-1 justify-center">
            {/* Govt Logo Placeholder */}
            <div className="w-20 h-20 bg-yellow-400 rounded-full border-4 border-white flex items-center justify-center shadow-md">
              <Building2 className="text-[#1e5eb8] w-10 h-10" />
            </div>
            
            <div className="flex flex-col items-center">
              <h1 className="text-2xl md:text-3xl font-bold mb-1 tracking-wide">ಬೆಂಗಳೂರು ನಗರ ಪಾಲಿಕೆಗಳು</h1>
              <h2 className="text-xl md:text-2xl text-yellow-300 font-bold mb-3 tracking-wider">ಇ-ಆಸ್ತಿ</h2>
              <div className="bg-blue-800/40 rounded px-4 py-2 border border-blue-400/30">
                <p className="text-sm">Welcome! You are visitor no</p>
                <p className="text-2xl font-bold font-mono tracking-widest text-yellow-400">5,57,26,483</p>
              </div>
            </div>

            {/* NIC Logo Placeholder */}
            <div className="bg-white px-3 py-2 rounded shadow-sm flex items-center h-12">
              <div className="flex gap-1 border-r border-gray-300 pr-2 mr-2">
                <div className="w-2 h-6 bg-[#1e5eb8]"></div>
                <div className="w-2 h-6 bg-[#1e5eb8]"></div>
                <div className="w-2 h-6 bg-[#1e5eb8]"></div>
              </div>
              <div className="text-[#1e5eb8] font-bold leading-none text-left">
                <span className="text-sm">National<br/>Informatics<br/>Centre</span>
              </div>
            </div>
          </div>

          {/* Right - Deputy CM Profile */}
          <div className="flex flex-col items-center text-center max-w-[150px]">
            <div className="w-16 h-16 rounded-full bg-gray-300 border-2 border-white overflow-hidden mb-2 shadow-sm flex items-center justify-center">
              <User className="text-gray-500 w-8 h-8" />
            </div>
            <p className="font-bold text-sm leading-tight">Sri DK. Shivakumar</p>
            <p className="text-[10px] text-gray-200 mt-1 leading-tight bg-black/20 p-1 rounded">Hon'ble Deputy Chief Minister<br/>and Minister for Bangalore City Development</p>
          </div>

        </div>
      </div>

      {/* Sub Header (White Strip) */}
      <div className="bg-white border-b border-gray-200 shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-3 flex flex-wrap justify-between items-center gap-4">
          <button className="flex items-center gap-2 px-4 py-2 bg-gray-50 border border-gray-200 hover:bg-gray-100 rounded text-sm font-medium transition-colors">
            <Building2 className="w-4 h-4 text-gray-500" />
            Department Login
          </button>
          
          <div className="flex items-center gap-3 text-lg font-medium">
            <span className="text-gray-600">GBA eKhata Helpline</span>
            <span className="text-gray-400">—</span>
            <div className="flex items-center gap-2 text-blue-600 font-bold text-xl">
              <Phone className="w-5 h-5" />
              9480683695
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-gray-100 rounded text-sm text-gray-600 border border-transparent hover:border-gray-200 transition-all">
              <Globe className="w-4 h-4" />
              ಕನ್ನಡ
            </button>
            <button className="flex items-center gap-2 px-4 py-2 bg-gray-50 border border-gray-200 hover:bg-gray-100 rounded text-sm font-medium transition-colors">
              <LogIn className="w-4 h-4 text-gray-500" />
              Login
            </button>
          </div>
        </div>
      </div>

      {/* Main Search Area */}
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <h2 className="text-3xl md:text-5xl font-bold mb-8 text-[#1e5eb8]">ಬೆಂಗಳೂರು ನಗರ ಪಾಲಿಕೆಗಳು</h2>
        
        <div className="relative max-w-2xl mx-auto group">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Search className="h-5 w-5 text-gray-400 group-focus-within:text-blue-500 transition-colors" />
          </div>
          <input
            type="text"
            className="block w-full pl-11 pr-4 py-4 border-2 border-blue-400/40 rounded-xl leading-5 bg-white placeholder-gray-400 focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-500 transition-all text-lg shadow-sm"
            placeholder="Search for services....."
          />
        </div>
      </div>

      {/* Citizen Services Section */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h3 className="text-2xl font-bold text-gray-900 mb-2">Citizen Services</h3>
          <p className="text-gray-500 text-sm">Apply for Khata, Amalgamation and property related services.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Service Card 1 */}
          <div className="bg-white rounded-xl border border-gray-100 p-6 shadow-sm hover:shadow-md transition-all cursor-pointer group flex flex-col h-full border-t-4 border-t-green-500 relative overflow-hidden">
            <div className="absolute top-4 right-4 w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center group-hover:border-blue-500 group-hover:bg-blue-50 transition-colors">
              <span className="text-gray-400 group-hover:text-blue-500 font-serif text-sm">↗</span>
            </div>
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-4">
              <FileText className="w-6 h-6 text-green-600" />
            </div>
            <h4 className="font-bold text-lg mb-2 text-gray-900">eKhata</h4>
            <p className="text-sm text-gray-500 mt-auto">Explore and apply for various citizen focused services like Khata, Amalgamation, and Property-related queries.</p>
          </div>

          {/* Service Card 2 */}
          <div className="bg-white rounded-xl border border-gray-100 p-6 shadow-sm hover:shadow-md transition-all cursor-pointer group flex flex-col h-full border-t-4 border-t-blue-500 relative overflow-hidden">
            <div className="absolute top-4 right-4 w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center group-hover:border-blue-500 group-hover:bg-blue-50 transition-colors">
              <span className="text-gray-400 group-hover:text-blue-500 font-serif text-sm">↗</span>
            </div>
            <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center mb-4">
              <CheckCircle className="w-6 h-6 text-blue-600" />
            </div>
            <h4 className="font-bold text-lg mb-2 text-gray-900">eKhata status based on ePID</h4>
            <p className="text-sm text-gray-500 mt-auto">Check Your e Khata status using your ePID number easily from our portal.</p>
          </div>

          {/* Service Card 3 */}
          <div className="bg-white rounded-xl border border-gray-100 p-6 shadow-sm hover:shadow-md transition-all cursor-pointer group flex flex-col h-full border-t-4 border-t-red-500 relative overflow-hidden">
            <div className="absolute top-4 right-4 w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center group-hover:border-blue-500 group-hover:bg-blue-50 transition-colors">
              <span className="text-gray-400 group-hover:text-blue-500 font-serif text-sm">↗</span>
            </div>
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4">
              <XCircle className="w-6 h-6 text-red-600" />
            </div>
            <h4 className="font-bold text-lg mb-2 text-gray-900">Click here to Withdraw Your eKhata Application</h4>
            <p className="text-sm text-gray-500 mt-auto">Withdraw your submitted eKhata application request from the system instantly.</p>
          </div>

          {/* Service Card 4 */}
          <div className="bg-white rounded-xl border border-gray-100 p-6 shadow-sm hover:shadow-md transition-all cursor-pointer group flex flex-col h-full border-t-4 border-t-orange-500 relative overflow-hidden">
            <div className="absolute top-4 right-4 w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center group-hover:border-blue-500 group-hover:bg-blue-50 transition-colors">
              <span className="text-gray-400 group-hover:text-blue-500 font-serif text-sm">↗</span>
            </div>
            <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center mb-4">
              <FilePlus className="w-6 h-6 text-orange-600" />
            </div>
            <h4 className="font-bold text-lg mb-2 text-gray-900">B to A Khata Conversion & Vacant Plot New A Khata</h4>
            <p className="text-sm text-gray-500 mt-auto">Apply for B to A Khata Conversion & Vacant Plot New A khata directly through this module.</p>
          </div>
        </div>
      </div>
      
    </div>
  );
}
