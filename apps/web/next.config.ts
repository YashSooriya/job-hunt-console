import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    "/*": ["./content/document-instructions/custom_CV_instructions.md", "./content/document-instructions/custom_Cover_Letter_instructions.md"],
  },
};

export default nextConfig;
