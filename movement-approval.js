const MODULE_ID = "movement-approval";
const LANGUAGE_PREFIX = "movementApproval";

const ICON_STATES = {
	ENABLED: "fa-person-walking-dashed-line-arrow-right",
	DISABLED: "fa-person-walking",
};

const PENDING_REQUEST_ICON = "fa-person-walking-dashed-line-arrow-right";
const PENDING_REQUEST_TOOL_NAME = "pendingMovementRequest";

const MovementApproval = {
	ID: MODULE_ID,
	lastWarningTime: 0,
	_pendingRequests: {},
	_staticPaths: {},

	/**
	 * Initialize the module by patching core methods and setting up listeners.
	 */
	initialize() {
		this.patchRulerMovement();
		this.patchTokenDragging();
		this.registerSocketListeners();
		setTimeout(() => {
			this.clearAllRulers();
		}, 1000);
	},

	/**
	 * Register the module settings.
	 */
	registerSettings() {
		game.settings.register(this.ID, "enabled", {
			name: "Enable Movement Approval",
			hint: "Requires GM approval for token movement beyond allowed distance.",
			scope: "world",
			config: false,
			type: Boolean,
			default: false,
			onChange: this.updateControlsIcon.bind(this),
		});
	},

	/**
	 * Get the enabled state of the module.
	 * @returns {boolean} Whether the module is enabled.
	 */
	getEnabled() {
		try {
			return game.settings.get(this.ID, "enabled");
		} catch (error) {
			console.warn(
				"Movement Approval: Settings not yet registered, falling back to default.",
			);
			return false;
		}
	},

	/**
	 * Set the enabled state of the module.
	 * @param {boolean} value - The new enabled state.
	 */
	setEnabled(value) {
		if (game.user.isGM) {
			game.settings.set(this.ID, "enabled", value);
		}
	},

	/**
	 * Emit a socket event.
	 * @param {string} type - The type of the event.
	 * @param {Object} payload - The payload of the event.
	 */
	emitSocket(type, payload) {
		game.socket.emit(`module.${this.ID}`, { type, payload });
	},

	/**
	 * Handle socket events for pending requests.
	 * @param {string} tokenId - The ID of the token.
	 * @param {Object|null} request - The request data or null to remove.
	 */
	handlePendingRequest(tokenId, request) {
		if (request === null) {
			if (this._pendingRequests[tokenId]?.dialog) {
				this._pendingRequests[tokenId].dialog.close();
			}
			delete this._pendingRequests[tokenId];
		} else {
			this._pendingRequests[tokenId] = request;
		}

		if (game.user.isGM) {
			this.emitSocket("updatePendingRequests", { [tokenId]: request });
		}
	},

	/**
	 * Set a pending request for a token.
	 * @param {string} tokenId - The ID of the token.
	 * @param {Object} request - The request data.
	 */
	setPendingRequest(tokenId, request) {
		this.handlePendingRequest(tokenId, request);
	},

	/**
	 * Remove a pending request for a token.
	 * @param {string} tokenId - The ID of the token.
	 */
	removePendingRequest(tokenId) {
		this.handlePendingRequest(tokenId, null);
	},

	/**
	 * Patch the Ruler.moveToken method to implement movement approval.
	 */
	patchRulerMovement() {
		const originalMoveToken = Ruler.prototype.moveToken;
		Ruler.prototype.moveToken = async function () {
			if (game.user.isGM || !MovementApproval.getEnabled()) {
				return originalMoveToken.call(this);
			}

			const token = this.token;
			if (!token) return false;

			if (MovementApproval._pendingRequests[token.id]) {
				ui.notifications.warn(
					game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.pendingRequest`),
				);
				this.clear();
				return false;
			}

			const pathData = {
				tokenId: token.id,
				rulerName: this.name,
				sceneId: token.scene.id,
				waypoints: this.waypoints,
				destination: this.destination,
				color: this.color,
				userId: game.user.id,
			};

			MovementApproval.emitSocket("requestMovement", pathData);
			ui.notifications.info(
				game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.requestSent`),
			);

			this.clear();
			MovementApproval.drawStaticPath(pathData);
			MovementApproval.showPendingRequestIcon();

			return false;
		};
	},

	/**
	 * Patch Token dragging methods to prevent movement when the module is enabled.
	 */
	patchTokenDragging() {
		const originalOnDragLeftStart = Token.prototype._onDragLeftStart;
		const originalOnDragLeftMove = Token.prototype._onDragLeftMove;

		Token.prototype._onDragLeftStart = function (event) {
			if (!game.user.isGM && MovementApproval.getEnabled()) {
				MovementApproval.showMovementLockedWarning();
				return false;
			}
			return originalOnDragLeftStart.call(this, event);
		};

		Token.prototype._onDragLeftMove = function (event) {
			if (!game.user.isGM && MovementApproval.getEnabled()) {
				MovementApproval.showMovementLockedWarning();
				return false;
			}
			return originalOnDragLeftMove.call(this, event);
		};
	},

	/**
	 * Show a warning when movement is locked.
	 */
	showMovementLockedWarning() {
		const now = Date.now();
		if (now - this.lastWarningTime > 5000) {
			ui.notifications.warn(
				game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.movementLocked`),
			);
			this.lastWarningTime = now;
		}
	},

	/**
	 * Register socket listeners for various events.
	 */
	registerSocketListeners() {
		game.socket.on(`module.${this.ID}`, (data) => {
			const handlers = {
				requestMovement: this.handleMovementRequest,
				movementApproved: this.handleMovementApproved,
				movementDenied: this.handleMovementDenied,
				cancelMovementRequest: this.handleCancelMovementRequest,
				updatePendingRequests: this.handleUpdatePendingRequests,
				requestCleanup: this.handleCleanupRequest,
			};

			const handler = handlers[data.type];
			if (handler) {
				handler.call(this, data.payload);
			}
		});
	},

	/**
	 * Handle a movement request from a player.
	 * @param {Object} data - The movement request data.
	 */
	handleMovementRequest(data) {
		this.setPendingRequest(data.tokenId, data);
		const scene = game.scenes.get(data.sceneId);
		const token = scene.tokens.get(data.tokenId);

		new Dialog({
			title: game.i18n.localize(`${LANGUAGE_PREFIX}.dialog.title`),
			content: game.i18n.format(`${LANGUAGE_PREFIX}.dialog.content`, {
				tokenName: token.name,
				tokenId: data.tokenId,
			}),
			type: `${MODULE_ID}-dialog`,
			tokenId: data.tokenId,
			userId: data.userId,
			buttons: {
				approve: {
					icon: '<i class="fas fa-check"></i>',
					label: game.i18n.localize(`${LANGUAGE_PREFIX}.dialog.approve`),
					callback: () => this.approveMovement(data),
				},
				deny: {
					icon: '<i class="fas fa-times"></i>',
					label: game.i18n.localize(`${LANGUAGE_PREFIX}.dialog.deny`),
					callback: () => this.denyMovement(data),
				},
			},
		}).render(true);
	},

	/**
	 * Handle the GM's response to a movement request.
	 * @param {string} type - The type of response (approved or denied).
	 * @param {Object} data - The movement request data.
	 */
	handleMovementResponse(type, data) {
		this.clearStaticPath(data.tokenId);
		this.removePendingRequest(data.tokenId);
		this.emitSocket(type, data);
		this.clearAllRulers();
	},

	/**
	 * handle Cleanup Request
	 */

	handleCleanupRequest() {
		this.clearAllRulers();
		this._pendingRequests = {};
		for (const path in this._staticPaths) {
			this.clearStaticPath(path);
		}
	},

	/**
	 * Approve a movement request.
	 * @param {Object} data - The movement request data.
	 */
	approveMovement(data) {
		this.handleMovementResponse("movementApproved", data);
	},

	/**
	 * Deny a movement request.
	 * @param {Object} data - The movement request data.
	 */
	denyMovement(data) {
		this.handleMovementResponse("movementDenied", data);
	},

	/**
	 * Handle a denied movement request.
	 * @param {Object} data - The movement request data.
	 */
	async handleMovementDenied(data) {
		ui.notifications.warn(
			game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.movementDenied`),
		);
		this.clearStaticPath(data.tokenId);
		this.clearAllRulers();
		this.hidePendingRequestIcon();
	},

	/**
	 * Handle an approved movement request.
	 * @param {Object} data - The movement request data.
	 */
	async handleMovementApproved(data) {
		const scene = game.scenes.get(data.sceneId);
		const token = scene.tokens.get(data.tokenId);

		if (token.actor.isOwner) {
			ui.notifications.info(
				game.i18n.localize(`${LANGUAGE_PREFIX}.notifications.movementApproved`),
			);
			await this.moveTokenAlongPath(token, data.waypoints, data.destination);
		}
		this.removePendingRequest(data.tokenId);
		this.clearStaticPath(data.tokenId);
		this.clearAllRulers();
		this.hidePendingRequestIcon();
	},

	/**
	 * Move a token along a path of waypoints.
	 * @param {Token} token - The token to move.
	 * @param {Array} waypoints - The waypoints of the path.
	 * @param {Object} destination - The final destination.
	 */
	async moveTokenAlongPath(token, waypoints, destination) {
		const moveToken = async (x, y) => {
			await token.update({ x: x - 50, y: y - 50 });
			await CanvasAnimation.getAnimation(token.object.animationName)?.promise;
		};

		for (const waypoint of waypoints) {
			await moveToken(waypoint.x, waypoint.y);
		}
		await moveToken(destination.x, destination.y);
	},

	/**
	 * Draw a static path on the canvas.
	 * @param {Object} pathData - The data for the path.
	 */
	drawStaticPath(pathData) {
		const { tokenId, waypoints, destination, color } = pathData;
		const graphics = new PIXI.Graphics();

		const drawLine = (width, lineColor, alpha) => {
			graphics.lineStyle(width, lineColor, alpha);
			this._drawPath(graphics, waypoints, destination);
		};

		drawLine(6, 0x000000, 0.5); // Draw the black outline
		drawLine(4, color, 0.7); // Draw the colored line on top

		canvas.controls.addChild(graphics);
		this._staticPaths[tokenId] = graphics;
	},

	/**
	 * Draw a path on a PIXI.Graphics object.
	 * @param {PIXI.Graphics} graphics - The graphics object to draw on.
	 * @param {Array} waypoints - The waypoints of the path.
	 * @param {Object} destination - The final destination.
	 */
	_drawPath(graphics, waypoints, destination) {
		graphics.moveTo(waypoints[0].x, waypoints[0].y);
		for (const wp of waypoints.slice(1)) {
			graphics.lineTo(wp.x, wp.y);
		}
		graphics.lineTo(destination.x, destination.y);
	},

	/**
	 * Clear a static path from the canvas.
	 * @param {string} tokenId - The ID of the token associated with the path.
	 */
	clearStaticPath(tokenId) {
		console.log("asked to clear static paths for", tokenId);
		if (this._staticPaths[tokenId]) {
			canvas.controls.removeChild(this._staticPaths[tokenId]);
			this._staticPaths[tokenId].destroy();
			delete this._staticPaths[tokenId];
		}
	},

	/**
	 * Handle toggling the movement lock.
	 */
	handleLockMovementToggle() {
		if (this.getEnabled() === true) {
			//we are about to disable the module
			// inform everyone else to clean up
			this.emitSocket("requestCleanup", {});

			// clean up our own stuff
			this.handleCleanupRequest();

			// close any open dialogs for this module
			for (const window of Object.values(ui.windows)) {
				if (
					window instanceof Dialog &&
					window.data.type === `${MODULE_ID}-dialog`
				) {
					window.close();
				}
			}
		}

		this.setEnabled(!this.getEnabled());
	},

	/**
	 * Update the controls icon based on the module's enabled state.
	 * @param {boolean} enabled - Whether the module is enabled.
	 */
	updateControlsIcon(enabled) {
		const icon = enabled ? ICON_STATES.ENABLED : ICON_STATES.DISABLED;
		const title = game.i18n.localize(
			`${LANGUAGE_PREFIX}.controls.lockMovement.${enabled ? "enabled" : "disabled"}`,
		);
		const controls = ui.controls.controls.find((c) => c.name === "token");
		if (controls) {
			const tool = controls.tools.find((t) => t.name === "lockMovement");
			if (tool) {
				tool.icon = `fas ${icon}`;
				tool.title = title;
				ui.controls.render();
			}
		}
	},

	/**
	 * Toggle the pending request icon in the controls.
	 * @param {boolean} show - Whether to show or hide the icon.
	 */
	togglePendingRequestIcon(show) {
		const controls = ui.controls.controls.find((c) => c.name === "token");
		if (controls) {
			const existingToolIndex = controls.tools.findIndex(
				(t) => t.name === PENDING_REQUEST_TOOL_NAME,
			);
			if (show && existingToolIndex === -1) {
				controls.tools.push({
					name: PENDING_REQUEST_TOOL_NAME,
					title: game.i18n.localize(
						`${LANGUAGE_PREFIX}.controls.pendingRequest.name`,
					),
					icon: `fas ${PENDING_REQUEST_ICON}`,
					button: true,
					visible: true,
					onClick: () => this.showCancelRequestDialog(),
				});
			} else if (!show && existingToolIndex !== -1) {
				controls.tools.splice(existingToolIndex, 1);
			}
			ui.controls.render();
		}
	},

	/**
	 * Show the pending request icon.
	 */
	showPendingRequestIcon() {
		this.togglePendingRequestIcon(true);
	},

	/**
	 * Hide the pending request icon.
	 */
	hidePendingRequestIcon() {
		this.togglePendingRequestIcon(false);
	},

	/**
	 * Show the dialog for canceling a movement request.
	 */
	showCancelRequestDialog() {
		new Dialog({
			title: game.i18n.localize(`${LANGUAGE_PREFIX}.cancelDialog.title`),
			content: game.i18n.localize(`${LANGUAGE_PREFIX}.cancelDialog.content`),
			buttons: {
				cancel: {
					icon: '<i class="fas fa-times"></i>',
					label: game.i18n.localize(`${LANGUAGE_PREFIX}.cancelDialog.cancel`),
					callback: () => this.cancelMovementRequest(),
				},
				close: {
					icon: '<i class="fas fa-check"></i>',
					label: game.i18n.localize(`${LANGUAGE_PREFIX}.cancelDialog.close`),
				},
			},
		}).render(true);
	},

	/**
	 * Cancel a pending movement request.
	 */
	cancelMovementRequest() {
		const tokenId = Object.keys(this._pendingRequests).find(
			(key) => this._pendingRequests[key].userId === game.user.id,
		);

		if (tokenId) {
			const request = this._pendingRequests[tokenId];
			if (request) {
				const userId = game.user.id;
				const { sceneId } = request;
				const scene = game.scenes.get(sceneId);
				const token = scene.tokens.get(tokenId);
				this.clearStaticPath(tokenId);
				this.removePendingRequest(tokenId);
				this.emitSocket("cancelMovementRequest", {
					userId,
					tokenId,
					sceneId,
					tokenName: token.name,
				});
				this.hidePendingRequestIcon();
				ui.notifications.info(
					game.i18n.localize(
						`${LANGUAGE_PREFIX}.notifications.requestCancelled`,
					),
				);
			} else {
				console.warn(
					`Movement Approval: Attempted to cancel non-existent request for token ${tokenId}`,
				);
				this.hidePendingRequestIcon();
			}
		} else {
			console.warn(
				"Movement Approval: No pending request found for current user",
			);
			this.hidePendingRequestIcon();
		}
	},

	/**
	 * Handle a canceled movement request.
	 * @param {Object} data - The canceled request data.
	 */
	handleCancelMovementRequest(data) {
		this.clearStaticPath(data.tokenId);
		this.clearRuler(data);
		this.removePendingRequest(data.tokenId);

		const dialogToClose = Object.values(ui.windows).find(
			(w) =>
				w instanceof Dialog &&
				w.data.type === `${MODULE_ID}-dialog` &&
				w.data.tokenId === data.tokenId,
		);

		if (dialogToClose) {
			dialogToClose.close();
		}

		ui.notifications.info(
			game.i18n.format(
				`${LANGUAGE_PREFIX}.notifications.requestCancelledByUser`,
				{
					tokenName: data.tokenName,
				},
			),
		);
	},

	/**
	 * Handle updates to pending requests.
	 * @param {Object} updates - The updates to apply.
	 */
	handleUpdatePendingRequests(updates) {
		for (const [tokenId, request] of Object.entries(updates)) {
			this.handlePendingRequest(tokenId, request);
		}
		this.updatePendingRequestIcon();
	},

	/**
	 * Update the pending request icon based on current requests.
	 */
	updatePendingRequestIcon() {
		const hasPendingRequest = Object.values(this._pendingRequests).some(
			(request) => request.userId === game.user.id,
		);
		this.togglePendingRequestIcon(hasPendingRequest);
	},

	/**
	 * Clear specific ruler from the canvas that belongs to the data.
	 * @param {Object} data - The data for the ruler to clear.
	 */
	clearRuler(data) {
		console.log("should clear ruler", data);
		const ruler = canvas.controls.rulers.children.find(
			(ruler) => ruler.name === `Ruler.${data.userId}`,
		);
		if (ruler) ruler.clear();
	},

	/**
	 * Clear all rulers from the canvas.
	 */
	clearAllRulers() {
		for (const ruler of canvas.controls.rulers.children) {
			ruler.clear();
		}
	},

	/**
	 * Handle a client disconnection.
	 * @param {number} roleId - The ID of the disconnected users role.
	 * @param {string} userId - The ID of the disconnected user.
	 */
	handleClientDisconnection(roleId, userId) {
		console.log("client disconnected", roleId, userId);

		const cleanupRequests = (tokenIds) => {
			for (const tokenId of tokenIds) {
				const request = this._pendingRequests[tokenId];
				const scene = game.scenes.get(request.sceneId);
				const token = scene.tokens.get(tokenId);

				this.clearStaticPath(tokenId);
				this.removePendingRequest(tokenId);

				if (game.user.isGM) {
					ui.notifications.info(
						game.i18n.format(
							`${LANGUAGE_PREFIX}.notifications.requestCancelledByDisconnect`,
							{ tokenName: token.name },
						),
					);

					// Close any open dialogs for this request
					const dialogToClose = Object.values(ui.windows).find(
						(w) =>
							w instanceof Dialog &&
							w.data.type === `${MODULE_ID}-dialog` &&
							w.data.tokenId === tokenId,
					);
					if (dialogToClose) {
						dialogToClose.close();
					}
				}
			}
		};

		if (roleId === 4) {
			// DM disconnected
			const tokenIdsToCancel = Object.keys(this._pendingRequests);
			cleanupRequests(tokenIdsToCancel);
		} else if (game.user.isGM) {
			// Player disconnected
			const tokenIdsToCancel = Object.entries(this._pendingRequests)
				.filter(([_, request]) => request.userId === userId)
				.map(([tokenId, _]) => tokenId);
			cleanupRequests(tokenIdsToCancel);
		}
	},
};

Hooks.once("ready", () => {
	MovementApproval.initialize();
});

Hooks.once("setup", () => {
	MovementApproval.registerSettings();
});

Hooks.on("userConnected", (info) => {
	if (!info.active) {
		MovementApproval.handleClientDisconnection(
			info._source.role,
			info._source._id,
		);
	}
});

Hooks.on("getSceneControlButtons", (controls) => {
	controls
		.find((c) => c.name === "token")
		.tools.push({
			name: "lockMovement",
			title: game.i18n.localize(
				`${LANGUAGE_PREFIX}.controls.lockMovement.${MovementApproval.getEnabled() ? "enabled" : "disabled"}`,
			),
			icon: `fas ${
				MovementApproval.getEnabled()
					? ICON_STATES.ENABLED
					: ICON_STATES.DISABLED
			}`,
			button: true,
			visible: game.user.isGM,
			onClick: () => MovementApproval.handleLockMovementToggle(),
		});
});
