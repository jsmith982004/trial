import React from "react";
import Navigation from "./Navigation";

function LandingPage() {
  return (
    <div>
      <Navigation />
      <div className="h-[500px] flex justify-center  bg-slate-900">
        <h1 className="text-5xl flex text-white font-bold text-center items-center">
          Welcome to Sellit
        </h1>
      </div>
      <div>Welocome to our website</div>
    </div>
  );
}

export default LandingPage;
