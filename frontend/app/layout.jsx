import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";

export const metadata = {
  title: "STAR — SAP Transformation Accelerator Roadmap",
  description: "AI-enabled SAP transformation assessment: recommends approach (Greenfield / Brownfield / Bluefield) and deployment from business and technical inputs and SAP analysis exports.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
