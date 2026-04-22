import { AppError } from '@/lib/errors';
import { articlesRepository, CreateArticleInput, UpdateArticleInput } from './articles.repository';
import { createLogger } from '@/lib/logger';

const log = createLogger('articles-service');

const generateSlug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100);

export const articlesService = {
  // ─── Public ────────────────────────────────────────────────────────────

  async list(filters: { category?: string; page: number; limit: number }) {
    const [articles, total] = await articlesRepository.list({
      category: filters.category as any,
      publishedOnly: true,
      page: filters.page,
      limit: filters.limit,
    });

    return {
      articles,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        pages: Math.ceil(total / filters.limit),
      },
    };
  },

  async getBySlug(slug: string) {
    const article = await articlesRepository.findBySlug(slug);
    if (!article || !article.isPublished) throw AppError.notFound('Article not found');
    return article;
  },

  // ─── Admin ─────────────────────────────────────────────────────────────

  async adminList(filters: { category?: string; page: number; limit: number }) {
    const [articles, total] = await articlesRepository.list({
      category: filters.category as any,
      publishedOnly: false, // Admins see drafts too
      page: filters.page,
      limit: filters.limit,
    });

    return {
      articles,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        pages: Math.ceil(total / filters.limit),
      },
    };
  },

  async create(data: Omit<CreateArticleInput, 'slug'> & { slug?: string }) {
    const slug = data.slug?.trim() || generateSlug(data.title);

    const existing = await articlesRepository.slugExists(slug);
    if (existing) throw AppError.conflict(`Slug "${slug}" is already in use`);

    const article = await articlesRepository.create({ ...data, slug });

    log.info('Article created', { id: article.id, slug });
    return article;
  },

  async update(id: string, data: UpdateArticleInput & { slug?: string }) {
    const article = await articlesRepository.findById(id);
    if (!article) throw AppError.notFound('Article not found');

    if (data.slug) {
      const conflict = await articlesRepository.slugExists(data.slug, id);
      if (conflict) throw AppError.conflict(`Slug "${data.slug}" is already in use`);
    }

    const updated = await articlesRepository.update(id, data);
    log.info('Article updated', { id });
    return updated;
  },

  async delete(id: string) {
    const article = await articlesRepository.findById(id);
    if (!article) throw AppError.notFound('Article not found');

    await articlesRepository.delete(id);
    log.info('Article deleted', { id });
  },
};
