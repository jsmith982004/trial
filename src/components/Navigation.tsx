import React, { useState } from "react";
import images from "../images/images.jpeg";

function Navigation() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  return (
    <nav className="flex justify-between items-center bg-white p-4">
      {/* Left side */}
      <div>
        <h1 className="text-3xl text-emerald-800 font-bold">Sellit</h1>
      </div>

      {/* Right side */}
      <ul className="flex space-x-8 text-black text-xl items-center">
        <li className="cursor-pointer hover:text-emerald-700">Home</li>
        <li className="cursor-pointer hover:text-emerald-700">Browse Items</li>
        <li className="cursor-pointer hover:text-emerald-700">Contact Us</li>

        <li>
          {!isLoggedIn ? (
            <button
              className="
                px-6 py-2 rounded-md
                font-semibold text-white
                bg-gradient-to-r from-emerald-500 to-teal-400
                hover:from-teal-400 hover:to-emerald-500
                transition-colors duration-600
                shadow-lg
                focus:outline-none focus:ring-4 focus:ring-emerald-300
              "
              onClick={() => setIsLoggedIn(true)}
            >
              Sign In
            </button>
          ) : (
            <img
              src={images}
              alt="User Avatar"
              className="w-13 h-13 rounded-full cursor-pointer border-2 border-emerald-500"
              title="User Profile"
              onClick={() => setIsLoggedIn(false)}
            />
          )}
        </li>
      </ul>
    </nav>
  );
}

export default Navigation;
