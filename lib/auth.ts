import type { NextAuthOptions, Session } from "next-auth";
import { getServerSession } from "next-auth";
import Google from "next-auth/providers/google";
import type { JWT } from "next-auth/jwt";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "./prisma";

export const authOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.trim().toLowerCase();
      if (!email) {
        return false;
      }

      const allowed = await prisma.allowedEmail.findUnique({ where: { email } });
      if (!allowed) {
        console.warn(`Blocked sign-in attempt for unauthorized email: ${email}`);
        return false;
      }

      return true;
    },
    session({ session, token }: { session: Session; token: JWT }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
  secret: process.env.AUTH_SECRET,
} satisfies NextAuthOptions;

type SessionUser = NonNullable<Session["user"]> & { id: string };

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return null;
  }

  const userId = session.user.id;

  const existingUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!existingUser) {
    try {
      await prisma.user.create({
        data: {
          id: userId,
          email: session.user.email ?? null,
          name: session.user.name ?? null,
          image: session.user.image ?? null,
        },
      });
    } catch (error) {
      console.error("Failed to ensure user exists", error);
      return null;
    }
  }

  return session.user as SessionUser;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}
