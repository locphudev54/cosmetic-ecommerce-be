# Cosmetic Ecommerce Server

## Run with Docker

Build Docker image from the `server` folder:

```powershell
cd server
docker build -t cosmetic-server .
```

Run the container:

```powershell
docker run --rm --name cosmetic-server --env-file .env.prod -p 8000:8000 cosmetic-server
```

Open Swagger at `http://localhost:8000/docs` if `SWAGGER_ENABLED=true`.

If PostgreSQL or Redis runs on your host machine, use `host.docker.internal` in `.env.prod`, for example:

```env
DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/cosmetic_ecommerce?schema=public
REDIS_HOST=host.docker.internal
```

Run database migrations before starting the container:

```powershell
docker run --rm --env-file .env.prod cosmetic-server npx prisma migrate deploy
```
