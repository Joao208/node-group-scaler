NODE=node
NPM=npm
PNPM=pnpm

GREEN=\033[0;32m
NC=\033[0m

.PHONY: all install build clean

all: install build

install:
	@echo "$(GREEN)Installing dependencies...$(NC)"
	$(PNPM) install

build:
	@echo "$(GREEN)Building project...$(NC)"
	$(PNPM) build

clean:
	@echo "$(GREEN)Cleaning project...$(NC)"
	rm -rf dist
	rm -rf node_modules
	rm -f pnpm-lock.yaml