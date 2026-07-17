# FURSOY Mail Privacy Policy

Last updated: July 17, 2026

FURSOY Mail is a desktop Gmail client focused on fast notifications and one-click copying of verification codes. This policy explains what data the app accesses, why it accesses that data, where the data is stored, and the choices available to users.

## Data the app accesses

When you connect a Google account, FURSOY Mail uses Google OAuth to access:

- your basic Google profile information, such as your email address, display name, and profile picture;
- Gmail message metadata and content needed to display, search, synchronize, and detect verification codes;
- attachment data when you choose to view or download an attachment;
- Gmail operations you explicitly request, including sending mail and changing a message's mailbox state or labels.

FURSOY Mail requests the Gmail `gmail.modify` scope because its mail-client features require reading messages, sending mail, and organizing messages. It also requests basic profile and email identity scopes so connected accounts can be identified in the app.

## How data is used

Google user data is used only to provide user-facing features in FURSOY Mail. This includes synchronizing mail, showing notifications, detecting verification codes, copying a code at your request, rendering messages, downloading attachments, and performing mail actions that you initiate.

FURSOY Mail does not sell Google user data, use it for advertising, or use it to build advertising profiles. FURSOY Mail does not collect crash reports, diagnostics, usage statistics, or telemetry.

FURSOY Mail's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including its Limited Use requirements.

## Storage and transfers

- FURSOY Mail does not operate a server that receives or stores your mailbox data.
- OAuth access and refresh tokens are stored in the operating system credential store.
- Account details, mail cache, message content, attachment metadata, and app preferences are stored locally on your device.
- The app connects directly from your device to Google services for authentication and Gmail features.
- If remote images are allowed by your settings, loading a message image can contact the image's original third-party host. That host may receive ordinary network information such as your IP address.
- The built-in updater connects to the project's GitHub Releases distribution to check for and download app updates.

## Retention and deletion

Local mail data remains on your device until you remove the account from FURSOY Mail, reset the local mailbox, or remove the app data. Removing an account from the app deletes its local cache and stored OAuth credentials. This does not delete messages from your Google account unless you separately perform a Gmail deletion action.

You can revoke FURSOY Mail's Google access at any time from your Google Account's third-party connections page.

## Security

FURSOY Mail uses OAuth rather than asking for your Google password. Tokens are kept in the operating system credential store, and the app limits requested Google permissions to those required by its current features. No method of local storage or network transmission can be guaranteed to be completely secure.

## Changes to this policy

This policy may be updated when the app's data practices or features change. Material changes will be reflected by updating the date at the top of this page.

## Contact

Privacy questions and requests can be submitted through the [FURSOY Mail issue tracker](https://github.com/FURSOY/FURSOY-Mail/issues).

---

# FURSOY Mail Gizlilik Politikası

Son güncelleme: 17 Temmuz 2026

FURSOY Mail, hızlı bildirimlere ve doğrulama kodlarının tek tıkla kopyalanmasına odaklanan bir masaüstü Gmail istemcisidir. Bu politika, uygulamanın hangi verilere neden eriştiğini, verileri nerede sakladığını ve kullanıcıların sahip olduğu seçenekleri açıklar.

## Uygulamanın eriştiği veriler

Bir Google hesabı bağladığınızda FURSOY Mail, Google OAuth aracılığıyla şunlara erişir:

- e-posta adresi, görünen ad ve profil fotoğrafı gibi temel Google profil bilgileri;
- mailleri görüntülemek, aramak, senkronize etmek ve doğrulama kodlarını algılamak için gereken Gmail ileti üst verileri ve içerikleri;
- bir eki görüntülemeyi veya indirmeyi seçtiğinizde ek verileri;
- mail gönderme ve bir iletinin posta kutusu durumunu ya da etiketlerini değiştirme gibi açıkça başlattığınız Gmail işlemleri.

FURSOY Mail; mail istemcisi özellikleri iletileri okumayı, mail göndermeyi ve iletileri düzenlemeyi gerektirdiği için Gmail `gmail.modify` kapsamını ister. Bağlı hesapların uygulamada tanınabilmesi için temel profil ve e-posta kimliği kapsamlarını da ister.

## Verilerin kullanım amacı

Google kullanıcı verileri yalnızca FURSOY Mail'in kullanıcıya sunduğu özellikleri sağlamak için kullanılır. Bunlar; mailleri senkronize etme, bildirim gösterme, doğrulama kodlarını algılama, isteğiniz üzerine kod kopyalama, iletileri görüntüleme, ekleri indirme ve başlattığınız mail işlemlerini gerçekleştirmedir.

FURSOY Mail, Google kullanıcı verilerini satmaz; reklam için kullanmaz ve reklam profili oluşturmaz. FURSOY Mail; çökme raporları, tanılama verileri, kullanım istatistikleri veya telemetri toplamaz.

FURSOY Mail'in Google API'lerinden aldığı bilgileri kullanması ve aktarması, Sınırlı Kullanım şartları dâhil [Google API Hizmetleri Kullanıcı Verileri Politikası'na](https://developers.google.com/terms/api-services-user-data-policy) uyar.

## Saklama ve aktarımlar

- FURSOY Mail, posta kutusu verilerinizi alan veya saklayan bir sunucu işletmez.
- OAuth erişim ve yenileme belirteçleri işletim sisteminin kimlik bilgisi kasasında saklanır.
- Hesap bilgileri, mail önbelleği, ileti içeriği, ek üst verileri ve uygulama tercihleri cihazınızda yerel olarak saklanır.
- Uygulama, kimlik doğrulama ve Gmail özellikleri için cihazınızdan doğrudan Google hizmetlerine bağlanır.
- Ayarlarınız uzak görsellere izin veriyorsa bir ileti görseli yüklenirken görselin ait olduğu üçüncü taraf sunucuya bağlanılabilir. Bu sunucu IP adresiniz gibi olağan ağ bilgilerini alabilir.
- Yerleşik güncelleyici, uygulama güncellemelerini kontrol etmek ve indirmek için projenin GitHub Releases dağıtımına bağlanır.

## Saklama süresi ve silme

Yerel mail verileri; hesabı FURSOY Mail'den kaldırana, yerel posta kutusunu sıfırlayana veya uygulama verilerini silene kadar cihazınızda kalır. Bir hesabı uygulamadan kaldırmak, o hesaba ait yerel önbelleği ve saklanan OAuth kimlik bilgilerini siler. Ayrıca bir Gmail silme işlemi yapmadığınız sürece bu işlem Google hesabınızdaki iletileri silmez.

FURSOY Mail'in Google erişimini Google Hesabınızdaki üçüncü taraf bağlantıları sayfasından istediğiniz zaman iptal edebilirsiniz.

## Güvenlik

FURSOY Mail, Google parolanızı istemek yerine OAuth kullanır. Belirteçler işletim sisteminin kimlik bilgisi kasasında tutulur ve uygulama, istediği Google izinlerini mevcut özellikleri için gerekenlerle sınırlar. Hiçbir yerel saklama veya ağ aktarımı yönteminin tamamen güvenli olduğu garanti edilemez.

## Bu politikadaki değişiklikler

Uygulamanın veri uygulamaları veya özellikleri değiştiğinde bu politika güncellenebilir. Önemli değişiklikler, bu sayfanın başındaki tarihin güncellenmesiyle belirtilir.

## İletişim

Gizlilik soruları ve talepleri [FURSOY Mail sorun takipçisi](https://github.com/FURSOY/FURSOY-Mail/issues) üzerinden iletilebilir.
