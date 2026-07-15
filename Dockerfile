FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY . .

# 创建必要的目录
RUN mkdir -p logs uploads/import

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "src/app.js"]
