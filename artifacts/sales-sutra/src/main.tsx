import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { getStoredToken } from "@/hooks/use-auth";

setAuthTokenGetter(() => getStoredToken());

createRoot(document.getElementById("root")!).render(<App />);
