# SSHDeck eşitleme sunucusu. Bağımlılık yok: yalnız Node ve tek dosya.
FROM node:22-alpine
WORKDIR /app
COPY sync-server.js ./
# /data adlandırılmış birime bağlanır; ilk bağlamada sahipliği buradan alır (root olmayan node kullanıcısı)
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=3150 HOST=0.0.0.0 DATA_DIR=/data NODE_ENV=production
EXPOSE 3150
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/info').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "sync-server.js"]
