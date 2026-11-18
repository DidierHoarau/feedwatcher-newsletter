import { FastifyInstance, FastifyRequest } from "fastify";
import { Config } from "../Config";
import { OTelLogger, OTelRequestSpan, OTelRunWithRequestContext } from "../OTelContext";
import { EmailItemGetById, EmailItemsListById } from "../emails/EmailsData";
import { SanitizedBodyCacheGet } from "../emails/SanitizedBodyCache";
import {
  FeedIdentityGetFeedId,
  FeedIdentityGetFeedUrlId,
  FeedIdentityGetTitle,
} from "../feeds/FeedIdentity";
import {
  FeedSettingsGetBlockRemoteImages,
  FeedSettingsGetForFeed,
  FeedSettingsGetStripTrackingPixels,
  FeedSettingsIsHidden,
  FeedSettingsResolveMergeTarget,
} from "../feeds/FeedSettings";
import { FeedListingGetBaseUrl } from "../feeds/FeedListing";
import { renderViewPage, ViewPageNavigation } from "./HtmlPages";

const logger = OTelLogger().createModuleLogger("ViewRoutes");

// Feed link and newer/older neighbours for the /view page. The containing
// feed's items are newest-first, so the previous index is the newer item and
// the next index the older one. An item whose sender is not listed as a feed
// (unknown sender) gets no navigation. Merged sources resolve to their final
// feed; a hidden final feed exposes no navigation.
function buildViewNavigation(
  config: Config,
  request: FastifyRequest,
  email: { id: string; senderName: string; senderEmail: string },
): ViewPageNavigation {
  const feedId = FeedSettingsResolveMergeTarget(
    FeedIdentityGetFeedId(email.senderName, email.senderEmail),
  );
  if (FeedSettingsIsHidden(feedId)) {
    return {};
  }
  const items = EmailItemsListById(feedId);
  const index = items.findIndex((item) => item.id === email.id);
  if (index === -1) {
    return {};
  }
  return {
    feed: {
      url: `${FeedListingGetBaseUrl(config, request)}/rss/${FeedIdentityGetFeedUrlId(
        feedId,
      )}`,
      title:
        FeedSettingsGetForFeed(feedId)?.title ??
        FeedIdentityGetTitle(email.senderName, email.senderEmail),
    },
    previous: index > 0 ? items[index - 1] : undefined,
    next: index + 1 < items.length ? items[index + 1] : undefined,
  };
}

// Readable permalink pages for individual emails, the link target of feed
// items.
export class ViewRoutes {
  constructor(private config: Config) {}

  public getRoutes = async (fastify: FastifyInstance) => {
    fastify.get<{ Params: { emailId: string } }>(
      "/view/:emailId",
      async (request, reply) =>
        OTelRunWithRequestContext(request, async () => {
          const span = OTelRequestSpan(request);
          const { emailId } = request.params;
          const email = EmailItemGetById(emailId);
          if (!email) {
            logger.info(`Email not found for view: ${emailId}`, span);
            reply.code(404);
            return reply.send({ error: "Email not found" });
          }
          reply.header("Content-Type", "text/html; charset=utf-8");
          const feedId = FeedSettingsResolveMergeTarget(
            FeedIdentityGetFeedId(email.senderName, email.senderEmail),
          );
          const sanitized = SanitizedBodyCacheGet(
            email,
            FeedSettingsGetStripTrackingPixels(
              feedId,
              this.config.EMAIL_STRIP_TRACKING_PIXELS,
            ),
            FeedSettingsGetBlockRemoteImages(
              feedId,
              this.config.EMAIL_BLOCK_REMOTE_IMAGES,
            ),
          );
          const navigation = buildViewNavigation(this.config, request, email);
          return reply.send(renderViewPage(email, sanitized.html, navigation));
        }),
    );
  };
}
