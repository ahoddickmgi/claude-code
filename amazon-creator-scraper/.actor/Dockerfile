FROM apify/actor-node-playwright-chrome:18

COPY package*.json ./

RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Playwright browsers installed"

COPY . ./

CMD npm start --silent
