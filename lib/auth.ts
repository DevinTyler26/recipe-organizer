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
    async session({ session, token }: { session: Session; token: JWT }) {
      if (session.user) {
        if (token.sub) {
          session.user.id = token.sub;
        }
        session.user.isAdmin = Boolean(token.isAdmin);
      }
      return session;
    },
    async jwt({ token }: { token: JWT }) {
      if (!token.sub) {
        token.isAdmin = false;
        return token;
      }

      const user = await prisma.user.findUnique({
        where: { id: token.sub },
        select: { isAdmin: true },
      });

      token.isAdmin = Boolean(user?.isAdmin);
      return token;
    },
  },
  secret: process.env.AUTH_SECRET,
} satisfies NextAuthOptions;

type SessionUser = NonNullable<Session["user"]> & { id: string; isAdmin: boolean };

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return null;
  }

  const userId = session.user.id;

  let existingUser = await prisma.user.findUnique({ where: { id: userId } });
  if (!existingUser) {
    try {
      existingUser = await prisma.user.create({
        data: {
          id: userId,
          email: session.user.email ?? null,
          name: session.user.name ?? null,
          image: session.user.image ?? null,
          isAdmin: false,
        },
      });
    } catch (error) {
      console.error("Failed to ensure user exists", error);
      return null;
    }
  }

  const sessionUser = session.user as SessionUser;
  if (typeof sessionUser.isAdmin !== "boolean") {
    sessionUser.isAdmin = Boolean(existingUser?.isAdmin);
  }
  return sessionUser;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Unauthorized");
  }
  return user;
}

export async function requireAdminUser(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) {
    throw new Error("Forbidden");
  }
  return user;
}
