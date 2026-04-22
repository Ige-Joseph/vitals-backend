import request from 'supertest';
import { createApp } from '@/app';
import { prisma } from '@/lib/prisma';
import jwt from 'jsonwebtoken';

jest.mock('@/lib/prisma', () => ({
  prisma: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
    article: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock('@/lib/redis', () => ({
  redisConnection: { ping: jest.fn(), on: jest.fn(), disconnect: jest.fn() },
}));

const app = createApp();

const JWT_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret-minimum-32-characters-long';

const makeToken = (role = 'USER') =>
  jwt.sign(
    { sub: 'user-1', email: 'test@example.com', role, planType: 'FREE', emailVerified: true },
    JWT_SECRET,
    { expiresIn: '15m' },
  );

const mockArticle = {
  id: 'article-1',
  title: 'Understanding pregnancy',
  slug: 'understanding-pregnancy',
  excerpt: 'A guide to the first trimester.',
  content: 'Full article content here.',
  imageUrl: null,
  category: 'PREGNANCY',
  isPublished: true,
  publishedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('GET /api/v1/articles', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 with article list (no auth required)', async () => {
    (prisma.article.findMany as jest.Mock).mockResolvedValue([mockArticle]);
    (prisma.article.count as jest.Mock).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/articles');

    expect(res.status).toBe(200);
    expect(res.body.data.articles).toHaveLength(1);
    expect(res.body.data.pagination).toBeDefined();
  });

  it('filters by category', async () => {
    (prisma.article.findMany as jest.Mock).mockResolvedValue([mockArticle]);
    (prisma.article.count as jest.Mock).mockResolvedValue(1);

    const res = await request(app).get('/api/v1/articles?category=PREGNANCY');

    expect(res.status).toBe(200);
    expect(prisma.article.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: 'PREGNANCY' }),
      }),
    );
  });
});

describe('GET /api/v1/articles/:slug', () => {
  it('returns 200 for published article', async () => {
    (prisma.article.findUnique as jest.Mock).mockResolvedValue(mockArticle);

    const res = await request(app).get('/api/v1/articles/understanding-pregnancy');

    expect(res.status).toBe(200);
    expect(res.body.data.slug).toBe('understanding-pregnancy');
  });

  it('returns 404 for unpublished article', async () => {
    (prisma.article.findUnique as jest.Mock).mockResolvedValue({
      ...mockArticle,
      isPublished: false,
    });

    const res = await request(app).get('/api/v1/articles/draft-article');
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-existent article', async () => {
    (prisma.article.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get('/api/v1/articles/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/articles (admin)', () => {
  it('returns 403 for regular user', async () => {
    const res = await request(app)
      .post('/api/v1/articles')
      .set('Authorization', `Bearer ${makeToken('USER')}`)
      .send({
        title: 'Test Article',
        excerpt: 'A test excerpt that is long enough.',
        content: 'This is the full content of the test article, which must be at least 50 characters.',
        category: 'GENERAL',
      });

    expect(res.status).toBe(403);
  });

  it('returns 201 for admin user', async () => {
    (prisma.article.findFirst as jest.Mock).mockResolvedValue(null); // No slug conflict
    (prisma.article.create as jest.Mock).mockResolvedValue({
      ...mockArticle,
      title: 'New Article',
      slug: 'new-article',
    });

    const res = await request(app)
      .post('/api/v1/articles')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({
        title: 'New Article',
        excerpt: 'A meaningful excerpt for this article.',
        content: 'This is the full content of the article, which must be at least 50 characters long.',
        category: 'GENERAL',
        isPublished: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('returns 409 for duplicate slug', async () => {
    (prisma.article.findFirst as jest.Mock).mockResolvedValue(mockArticle); // Slug conflict

    const res = await request(app)
      .post('/api/v1/articles')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({
        title: 'Understanding pregnancy',
        excerpt: 'A meaningful excerpt for this article.',
        content: 'This is the full content of the article, which must be at least 50 characters long.',
        category: 'PREGNANCY',
      });

    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('CONFLICT');
  });
});

describe('DELETE /api/v1/articles/:id (admin)', () => {
  it('returns 200 for admin', async () => {
    (prisma.article.findUnique as jest.Mock).mockResolvedValue(mockArticle);
    (prisma.article.delete as jest.Mock).mockResolvedValue(mockArticle);

    const res = await request(app)
      .delete('/api/v1/articles/article-1')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
  });

  it('returns 403 for regular user', async () => {
    const res = await request(app)
      .delete('/api/v1/articles/article-1')
      .set('Authorization', `Bearer ${makeToken('USER')}`);

    expect(res.status).toBe(403);
  });
});
