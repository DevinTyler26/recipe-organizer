import { type DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      isAdmin: boolean;
      shoppingListLabel?: string | null;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sub?: string;
    isAdmin?: boolean;
    shoppingListLabel?: string | null;
  }
}
