import { useEffect } from "react";
import { ArrowRight, CheckCircle, TrendingUp, Users, Target, Zap, BarChart, Rocket } from "lucide-react";

export default function NmcDemo() {
  useEffect(() => {
    // Inject the widget script
    const s = document.createElement("script");
    // Uses window.location.origin so it automatically works in production (dialog.noeticminds.com)
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

  const services = [
    {
      icon: <TrendingUp className="h-8 w-8" />,
      title: "Digital Marketing",
      description: "Drive growth with data-driven digital marketing strategies that deliver measurable results.",
    },
    {
      icon: <Users className="h-8 w-8" />,
      title: "Sales-as-a-Service",
      description: "Scale your sales operations with our expert team and proven methodologies.",
    },
    {
      icon: <Target className="h-8 w-8" />,
      title: "Lead Generation",
      description: "Generate high-quality leads that convert into long-term customers.",
    },
    {
      icon: <Zap className="h-8 w-8" />,
      title: "AI Assistance",
      description: "Leverage AI-powered insights to transform lead generation, automate engagement, and scale growth.",
    },
    {
      icon: <BarChart className="h-8 w-8" />,
      title: "Lead Qualification",
      description: "HITL + AI-powered lead qualification that ensures every prospect is scored, matched, and primed for conversion.",
    },
    {
      icon: <Rocket className="h-8 w-8" />,
      title: "Social Media Marketing",
      description: "Build brand awareness and engage your audience across social platforms.",
    }
  ];

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900 overflow-x-hidden">
      {/* Header/Navbar */}
      <header className="bg-white/80 backdrop-blur-md sticky top-0 z-40 border-b border-gray-100 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            {/* NMC Logo placeholder mimicking the original */}
            <div className="w-10 h-10 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 flex items-center justify-center text-white font-bold text-lg shadow-lg">
              NMC
            </div>
            <span className="text-xl font-bold tracking-tight text-gray-900 hidden sm:block">
              Technology & Business Delivered!
            </span>
          </div>
          <div className="hidden lg:flex gap-8 font-semibold text-gray-600">
            <a href="#" className="hover:text-blue-600 transition-colors">Home</a>
            <a href="#" className="hover:text-blue-600 transition-colors">Services</a>
            <a href="#" className="hover:text-blue-600 transition-colors">Products</a>
            <a href="#" className="hover:text-blue-600 transition-colors">About Us</a>
            <a href="#" className="hover:text-blue-600 transition-colors">Blog</a>
          </div>
          <button className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-6 py-2.5 rounded-full font-bold transition-all shadow-md hover:shadow-lg transform hover:-translate-y-0.5">
            Start Trial
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative min-h-[90vh] flex items-center justify-center overflow-hidden">
        {/* Deep Gradient Background mimicking the original */}
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900"></div>
        {/* Subtle mesh/overlay pattern could go here */}
        <div className="absolute inset-0 opacity-20 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] mix-blend-overlay"></div>
        
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center z-10">
          <h1 className="text-5xl md:text-7xl lg:text-8xl font-extrabold mb-8 text-white tracking-tight drop-shadow-lg leading-tight">
            Transform Your Business with
            <span className="block text-yellow-400 mt-2 drop-shadow-md">Digital Excellence</span>
          </h1>
          <p className="text-xl md:text-2xl text-gray-100 mb-12 max-w-4xl mx-auto font-medium leading-relaxed drop-shadow">
            Stop wasting money on marketing that doesn't convert. Our AI-powered strategies deliver 
            <strong className="text-yellow-400 text-2xl font-bold"> 3X ROI </strong> 
            and turn your website into a lead-generating powerhouse that works while you sleep.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-6 justify-center items-center mb-16">
            <button className="px-10 py-5 bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-full font-bold text-lg shadow-[0_10px_25px_-5px_rgba(79,70,229,0.5)] hover:scale-105 transition-transform duration-300 flex items-center">
              Start Trial
              <ArrowRight className="ml-3 h-6 w-6" />
            </button>
            <button className="px-10 py-5 bg-white/10 backdrop-blur-sm border-2 border-white/80 text-white hover:bg-white hover:text-indigo-900 rounded-full font-bold text-lg shadow-xl hover:scale-105 transition-all duration-300">
              Schedule Consultation
            </button>
          </div>

          {/* Trust Indicators */}
          <div className="flex flex-wrap justify-center gap-8 md:gap-12 text-gray-100 font-semibold text-lg md:text-xl">
            <div className="flex items-center space-x-3 bg-white/5 backdrop-blur-sm px-4 py-2 rounded-xl border border-white/10">
              <CheckCircle className="h-7 w-7 text-green-400" />
              <span>100+ Successful Projects</span>
            </div>
            <div className="flex items-center space-x-3 bg-white/5 backdrop-blur-sm px-4 py-2 rounded-xl border border-white/10">
              <CheckCircle className="h-7 w-7 text-green-400" />
              <span>50+ Happy Clients</span>
            </div>
            <div className="flex items-center space-x-3 bg-white/5 backdrop-blur-sm px-4 py-2 rounded-xl border border-white/10">
              <CheckCircle className="h-7 w-7 text-green-400" />
              <span>10+ Years Experience</span>
            </div>
          </div>
        </div>
      </section>

      {/* Services Section */}
      <section className="py-24 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-20">
            <h2 className="text-4xl md:text-5xl font-extrabold mb-6 text-gray-900 tracking-tight">
              What We Do <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-indigo-600">Best</span>
            </h2>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto font-medium">
              Revenue-driving solutions that turn clicks into customers and visitors into loyal advocates.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {services.map((service, index) => (
              <div 
                key={index}
                className="bg-white p-10 rounded-3xl shadow-sm border border-gray-100 hover:shadow-2xl transition-all duration-300 hover:-translate-y-2 group cursor-pointer"
              >
                <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 mb-6 group-hover:scale-110 group-hover:bg-blue-600 group-hover:text-white transition-all duration-300 shadow-sm">
                  {service.icon}
                </div>
                <h3 className="text-2xl font-bold mb-4 text-gray-900 group-hover:text-blue-600 transition-colors">
                  {service.title}
                </h3>
                <p className="text-gray-600 mb-6 text-lg leading-relaxed">
                  {service.description}
                </p>
                <div className="flex items-center text-blue-600 font-bold text-lg">
                  Learn More
                  <ArrowRight className="ml-2 h-5 w-5 group-hover:translate-x-2 transition-transform" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
      
    </div>
  );
}
