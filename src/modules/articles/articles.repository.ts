import { prisma } from '@/lib/prisma';

export type ArticleCategory =
  | 'GENERAL'
  | 'PREGNANCY'
  | 'BABY_CARE'
  | 'MEDICATION'
  | 'NUTRITION'
  | 'MENTAL_HEALTH';

export interface CreateArticleInput {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  imageUrl?: string;
  category: ArticleCategory;
  isPublished?: boolean;
}

export interface UpdateArticleInput extends Partial<CreateArticleInput> {
  isPublished?: boolean;
}

export const articlesRepository = {
  create(data: CreateArticleInput) {
    return prisma.article.create({
      data: {
        ...data,
        publishedAt: data.isPublished ? new Date() : null,
      },
    });
  },

  findBySlug(slug: string) {
    return prisma.article.findUnique({ where: { slug } });
  },

  findById(id: string) {
    return prisma.article.findUnique({ where: { id } });
  },

  list(filters: { category?: ArticleCategory; publishedOnly?: boolean; page: number; limit: number }) {
    const { category, publishedOnly = true, page, limit } = filters;
    const where = {
      ...(category && { category }),
      ...(publishedOnly && { isPublished: true }),
    };

    return Promise.all([
      prisma.article.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          title: true,
          slug: true,
          excerpt: true,
          imageUrl: true,
          category: true,
          publishedAt: true,
          createdAt: true,
        },
      }),
      prisma.article.count({ where }),
    ]);
  },

  update(id: string, data: UpdateArticleInput) {
    return prisma.article.update({
      where: { id },
      data: {
        ...data,
        ...(data.isPublished === true && { publishedAt: new Date() }),
        ...(data.isPublished === false && { publishedAt: null }),
      },
    });
  },

  delete(id: string) {
    return prisma.article.delete({ where: { id } });
  },

  slugExists(slug: string, excludeId?: string) {
    return prisma.article.findFirst({
      where: {
        slug,
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
  },
};
