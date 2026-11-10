import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/inter";
import "./styles.css";
import { App } from "./App";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 1000, refetchOnWindowFocus: true, gcTime: 300000 },
    mutations: { retry: false },
  },
});

// Popmelt design toolbar: dev server only, so its client bundle never reaches the built dashboard.
const Popmelt = import.meta.env.DEV
  ? React.lazy(() => import("@popmelt.com/core").then((m) => ({ default: m.PopmeltProvider })))
  : React.Fragment;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <React.Suspense fallback={null}><Popmelt><App /></Popmelt></React.Suspense>
    </QueryClientProvider>
  </React.StrictMode>,
);
